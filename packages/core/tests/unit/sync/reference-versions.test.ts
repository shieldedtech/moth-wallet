import {describe, expect, it, vi} from 'vitest';
import {InMemorySyncStateStore, emptyRefHeightKey, emptyRefStateKey, cursorWitnessKey, EMPTY_REF_WALLET} from '../../../src/sync/sync-store.js';
import {
  REFERENCE_CATALOG_KEY, migrateReferenceVersions, saveReferenceVersion, selectReferenceVersion,
  registerReferenceWallet, referenceEpoch, resetReferenceVersions, forgetReferenceWallet,
  referenceContributionToken, referenceStillValid, selectDustReferenceCandidate, type ReferenceSnapshot,
} from '../../../src/sync/reference-versions.js';

const network = {id: 'preview', indexerUrl: 'http://unused.invalid'};
const good = async () => true;
function snapshot(height: number, net = network.id): ReferenceSnapshot {
  return {
    network: net, height,
    shielded: JSON.stringify({offset: String(height), state: 'shielded'}),
    unshielded: JSON.stringify({appliedId: '0', state: {availableUtxos: [], pendingUtxos: []}}),
    dust: JSON.stringify({offset: String(height + 1), state: 'dust'}),
    witnesses: {
      shielded: {stream: 'zswapLedgerEvents', id: height, digest: 'aaaaaaaaaaaaaaaa'},
      dust: {stream: 'dustLedgerEvents', id: height + 1, digest: 'bbbbbbbbbbbbbbbb'},
    },
  };
}
async function legacy(store: InMemorySyncStateStore, ref = snapshot(100)) {
  for (const part of ['shielded', 'unshielded', 'dust'] as const) await store.put(emptyRefStateKey(ref.network, part), ref[part]);
  for (const part of ['shielded', 'dust'] as const) await store.put(cursorWitnessKey(ref.network, EMPTY_REF_WALLET, part), JSON.stringify(ref.witnesses[part]));
  await store.put(emptyRefHeightKey(ref.network), String(ref.height));
}
async function catalog(store: InMemorySyncStateStore) { return JSON.parse((await store.get(REFERENCE_CATALOG_KEY))!).networks.preview; }

describe('reference versions and wallet assignments', () => {
  it('supports wallet names that also exist on Object.prototype', async () => {
    const store = new InMemorySyncStateStore();
    const original = await saveReferenceVersion(store, snapshot(100));
    for (const name of ['__proto__', 'constructor']) {
      await registerReferenceWallet(store, 'preview', {name, birthday: 250}, true);
      expect(await referenceContributionToken(store, 'preview', name)).toEqual(expect.any(String));
    }
    await saveReferenceVersion(store, snapshot(200));
    for (const name of ['__proto__', 'constructor']) {
      expect((await selectReferenceVersion(store, network, {name, birthday: 250}, good))?.id).toBe(original!.id);
    }
  });

  it('migrates and pins the old reference before an upgrade, including wallets currently on another network', async () => {
    const store = new InMemorySyncStateStore();
    await legacy(store);
    await migrateReferenceVersions(store, 'preview', [{name: 'old', birthday: 150}, {name: 'visiting', birthday: 170}]);
    const newer = await saveReferenceVersion(store, snapshot(200));
    const old = await selectReferenceVersion(store, network, {name: 'old', birthday: 150}, good);
    expect(old?.height).toBe(100);
    expect((await selectReferenceVersion(store, network, {name: 'visiting', birthday: 170}, good))?.id).toBe(old!.id);
    expect((await selectReferenceVersion(store, network, {name: 'new', birthday: 250}, good))?.id).toBe(newer!.id);
    expect(Object.keys((await catalog(store)).versions)).toHaveLength(2);
  });

  it('never seeds imported wallets or wallets older than a reference', async () => {
    const store = new InMemorySyncStateStore();
    await saveReferenceVersion(store, snapshot(200));
    const check = vi.fn(good);
    expect(await selectReferenceVersion(store, network, {name: 'imported'}, check)).toBeNull();
    expect(await selectReferenceVersion(store, network, {name: 'older', birthday: 150}, check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('offers a witnessed DUST candidate without assigning it as a wallet recovery reference', async () => {
    const store = new InMemorySyncStateStore();
    await saveReferenceVersion(store, snapshot(200));
    const check = vi.fn(good);
    expect((await selectDustReferenceCandidate(store, network, check))?.height).toBe(200);
    expect(check).toHaveBeenCalledOnce();
    expect((await catalog(store)).wallets).toEqual({});
    expect((await catalog(store)).contributors).toEqual({});
  });

  it('requires witnessed candidates even when legacy references allow missing witnesses', async () => {
    const store = new InMemorySyncStateStore();
    await legacy(store, {...snapshot(100), witnesses: {}});
    await migrateReferenceVersions(store, 'preview', []);
    const check = vi.fn(good);
    expect(await selectDustReferenceCandidate(store, network, check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('rejects DUST candidates that fail witness verification or are invalidated during the check', async () => {
    const store = new InMemorySyncStateStore();
    await saveReferenceVersion(store, snapshot(200));
    expect(await selectDustReferenceCandidate(store, network, async () => false)).toBeNull();
    expect(await selectDustReferenceCandidate(store, network, async () => {
      await resetReferenceVersions(store, 'preview');
      return true;
    })).toBeNull();
  });

  it('checks the pinned version against the current indexer on every recovery', async () => {
    const store = new InMemorySyncStateStore();
    await saveReferenceVersion(store, snapshot(100));
    const wallet = {name: 'alice', birthday: 150};
    const first = await selectReferenceVersion(store, network, wallet, good);
    expect(first).not.toBeNull();
    await saveReferenceVersion(store, snapshot(200));
    const rejected = vi.fn(async () => false);
    expect(await selectReferenceVersion(store, network, wallet, rejected)).toBeNull();
    expect(rejected).toHaveBeenCalledWith(first);
  });

  it('rejects malformed stored evidence without attempting the network', async () => {
    const ref = {...snapshot(100), id: 'test'};
    ref.witnesses.dust!.digest = 'broken';
    delete ref.witnesses.shielded;
    expect(await referenceStillValid(ref, network.indexerUrl)).toBe(false);
  });

  it('preserves the previous complete version when publishing fails', async () => {
    const store = new InMemorySyncStateStore();
    await saveReferenceVersion(store, snapshot(100));
    const before = await store.get(REFERENCE_CATALOG_KEY);
    const failing = {get: store.get.bind(store), delete: store.delete.bind(store), put: async () => {throw new Error('quota');}};
    await expect(saveReferenceVersion(failing, snapshot(200))).rejects.toThrow('quota');
    expect(await store.get(REFERENCE_CATALOG_KEY)).toBe(before);
  });

  it('retains assigned versions and the newest, collecting unassigned versions after wallet removal', async () => {
    const store = new InMemorySyncStateStore();
    const old = await saveReferenceVersion(store, snapshot(100));
    await registerReferenceWallet(store, 'preview', {name: 'alice', birthday: 150});
    await saveReferenceVersion(store, snapshot(200));
    const newest = await saveReferenceVersion(store, snapshot(300));
    expect(Object.keys((await catalog(store)).versions).sort()).toEqual([old!.id, newest!.id].sort());
    await forgetReferenceWallet(store, 'alice');
    expect(Object.keys((await catalog(store)).versions)).toEqual([newest!.id]);
  });

  it('a reset clears assignments and rejects a late worker result, while allowing bundle reinstall', async () => {
    const store = new InMemorySyncStateStore();
    await saveReferenceVersion(store, snapshot(100));
    await registerReferenceWallet(store, 'preview', {name: 'alice', birthday: 150}, true);
    const epoch = await referenceEpoch(store, 'preview');
    await resetReferenceVersions(store, 'preview');
    expect(await saveReferenceVersion(store, snapshot(200), {epoch})).toBeNull();
    expect((await catalog(store)).wallets).toEqual({});
    expect(await referenceContributionToken(store, 'preview', 'alice')).toBeNull();
    await saveReferenceVersion(store, snapshot(200));
    expect((await selectReferenceVersion(store, network, {name: 'new', birthday: 250}, good))?.height).toBe(200);
  });

  it('does not let a removed wallet donate under a reused name', async () => {
    const store = new InMemorySyncStateStore();
    await registerReferenceWallet(store, 'preview', {name: 'alice', birthday: 150}, true);
    const token = (await referenceContributionToken(store, 'preview', 'alice'))!;
    await forgetReferenceWallet(store, 'alice');
    await registerReferenceWallet(store, 'preview', {name: 'alice', birthday: 250}, true);
    expect(await saveReferenceVersion(store, snapshot(200), {contributor: {name: 'alice', token}})).toBeNull();
  });

  it('keeps networks separate and serializes concurrent catalog updates', async () => {
    const store = new InMemorySyncStateStore();
    await Promise.all([saveReferenceVersion(store, snapshot(100)), saveReferenceVersion(store, snapshot(300, 'preprod'))]);
    expect((await selectReferenceVersion(store, network, {name: 'alice', birthday: 150}, good))?.network).toBe('preview');
    expect((await selectReferenceVersion(store, {...network, id: 'preprod'}, {name: 'alice', birthday: 350}, good))?.network).toBe('preprod');
    expect((await selectReferenceVersion(store, network, {name: 'alice', birthday: 150}, good))?.height).toBe(100);
  });
});
