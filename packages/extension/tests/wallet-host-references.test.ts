import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ReferenceSnapshot} from '@shieldedtech/moth-wallet/sync/reference-versions';

const mocks = vi.hoisted(() => {
  const entries = new Map<string, string>();
  class Store {
    get = async (key: string) => entries.get(key) ?? null;
    put = async (key: string, value: string) => {entries.set(key, value);};
    delete = async (key: string) => {entries.delete(key);};
  }
  return {entries, Store, list: vi.fn(), birthdayOn: vi.fn(), generate: vi.fn(), start: vi.fn(), run: vi.fn(), cancel: vi.fn(), install: vi.fn()};
});
vi.mock('@shieldedtech/moth-browser', async importOriginal => ({
  ...await importOriginal<object>(),
  createMothBrowser: () => ({wallets: {list: mocks.list, birthdayOn: mocks.birthdayOn, generate: mocks.generate}}),
  IdbSyncStateStore: mocks.Store,
  IndexedDbStorageAdapter: class {
    list = async (prefix: string) => [...mocks.entries.keys()].filter(key => key.startsWith(prefix));
    delete = async (key: string) => {mocks.entries.delete(key);};
  },
  deriveWalletKeys: () => ({testKeys: true}),
  startWalletSync: mocks.start,
}));
vi.mock('../lib/offscreen/reference-jobs', () => ({runReferenceJob: mocks.run, cancelReferenceJob: mocks.cancel}));
vi.mock('../lib/offscreen/bundled-preseed', () => ({installBundledReference: mocks.install, hasBundledReference: async () => true}));
vi.mock('@shieldedtech/moth-wallet/sync/reference-versions', async importOriginal => {
  const actual = await importOriginal<typeof import('@shieldedtech/moth-wallet/sync/reference-versions')>();
  return {
    ...actual,
    selectReferenceVersion: (store: any, network: any, wallet: any) => actual.selectReferenceVersion(store, network, wallet, async () => true),
    selectDustReferenceCandidate: (store: any, network: any) => actual.selectDustReferenceCandidate(store, network, async () => true),
  };
});
import {walletCreate, syncEnsure, syncStop, syncCacheReset} from '../lib/offscreen/wallet-host';
import {migrateReferenceVersions, saveReferenceVersion, selectReferenceVersion, registerReferenceWallet, referenceVersionsStatus} from '@shieldedtech/moth-wallet/sync/reference-versions';
import {syncStateKey} from '@shieldedtech/moth-wallet/sync/sync-store';
import type {NetworkConfig} from '@shieldedtech/moth-browser';

const network = {id: 'preview', indexerUrl: 'https://indexer.invalid', nodeUrl: 'https://node.invalid'} as NetworkConfig;
const store = new mocks.Store();
const snapshot = (height: number): ReferenceSnapshot => ({
  network: network.id, height,
  shielded: JSON.stringify({offset: String(height)}), unshielded: '{}', dust: JSON.stringify({offset: String(height)}),
  witnesses: {shielded: {stream: 'zswapLedgerEvents', id: height, digest: 'aaaaaaaaaaaaaaaa'}, dust: {stream: 'dustLedgerEvents', id: height, digest: 'bbbbbbbbbbbbbbbb'}},
});
const selected = (name: string, birthday: number) => selectReferenceVersion(store, network, {name, birthday});
const options = () => mocks.start.mock.calls.at(-1)![6];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entries.clear();
  mocks.list.mockResolvedValue([{name: 'old', birthday: 150}, {name: 'new', birthday: 250}]);
  mocks.birthdayOn.mockImplementation(async (name: string) => name === 'old' ? 150 : 250);
  mocks.generate.mockResolvedValue({name: 'new', mnemonic: 'test phrase'});
  mocks.start.mockImplementation(async () => ({subscribe: () => () => {}, stop: async () => {}}));
  mocks.install.mockImplementation(async (id, target, wallets) => {
    await migrateReferenceVersions(target, id, wallets);
    await saveReferenceVersion(target, snapshot(200));
    return true;
  });
});
afterEach(async () => {await syncStop();});

describe('wallet host reference lifecycle', () => {
  it.each([undefined, 150])('passes a DUST candidate to core for birthday %s without enabling contributions', async (birthday) => {
    mocks.list.mockResolvedValue([{name: 'restored', birthday}]);
    mocks.birthdayOn.mockResolvedValue(birthday);
    await syncEnsure('unused', 'restored', network);
    expect(options().reference.height).toBe(200);
    expect(options().onInitialSyncSnapshot).toBeUndefined();
    expect(await selected('restored', birthday ?? 0)).toBeNull();
  });

  it('does not offer the DUST fallback when DUST is already cached', async () => {
    mocks.list.mockResolvedValue([{name: 'imported'}]);
    mocks.birthdayOn.mockResolvedValue(undefined);
    await store.put(syncStateKey('preview', 'imported', 'dust'), 'cached-dust');
    await syncEnsure('unused', 'imported', network);
    expect(options().reference).toBeNull();
    expect(options().onInitialSyncSnapshot).toBeUndefined();
    expect(await store.get(syncStateKey('preview', 'imported', 'dust'))).toBe('cached-dust');
  });

  it('pins existing wallets before an upgrade, and a just-created wallet to the newest version', async () => {
    await saveReferenceVersion(store, snapshot(100));
    await walletCreate('new', 'password', 'preview', 250);
    expect((await selected('old', 150))?.height).toBe(100);
    expect((await selected('new', 250))?.height).toBe(200);
    await syncEnsure('not-sent-to-worker', 'old', network);
    expect(options().reference.height).toBe(100);
    expect(options().onInitialSyncSnapshot).toBeUndefined();
  });

  it('lets first sync return before background work finishes and keeps the current assignment', async () => {
    await walletCreate('new', 'password', 'preview', 250);
    let finish!: (candidate: ReferenceSnapshot) => void;
    mocks.run.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    await syncEnsure('not-sent-to-worker', 'new', network);
    const captured = {shielded: 'immutable-sh', unshielded: 'immutable-un', dust: 'immutable-du'};
    expect(options().onInitialSyncSnapshot(captured)).toBeUndefined();
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledWith({kind: 'contribute', network, snapshot: captured, source: expect.objectContaining({height: 200})}));
    expect(JSON.stringify(mocks.run.mock.calls)).not.toContain('not-sent-to-worker');
    expect((await referenceVersionsStatus(store, 'preview')).height).toBe(200);
    finish(snapshot(300));
    await vi.waitFor(async () => expect((await referenceVersionsStatus(store, 'preview')).height).toBe(300));
    expect((await selected('new', 250))?.height).toBe(200);
    expect((await selected('future', 350))?.height).toBe(300);
  });

  it('declines contribution when resuming independently saved caches', async () => {
    await walletCreate('new', 'password', 'preview', 250);
    await store.put(syncStateKey('preview', 'new', 'dust'), 'partial-user-cache');
    await syncEnsure('unused', 'new', network);
    expect(options().onInitialSyncSnapshot).toBeUndefined();
    expect(await store.get(syncStateKey('preview', 'new', 'dust'))).toBe('partial-user-cache');
  });

  it('reset cancels work, rejects late publication, and reinstalls the bundle on the next sync', async () => {
    await walletCreate('new', 'password', 'preview', 250);
    let finish!: (candidate: ReferenceSnapshot) => void;
    mocks.run.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    await syncEnsure('unused', 'new', network);
    options().onInitialSyncSnapshot({shielded: 'sh', unshielded: 'un', dust: 'du'});
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    await syncCacheReset('new', network);
    expect(mocks.cancel).toHaveBeenCalledWith('preview');
    finish(snapshot(300));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await referenceVersionsStatus(store, 'preview')).ready).toBe(false);
    const installs = mocks.install.mock.calls.length;
    await syncEnsure('unused', 'new', network);
    expect(mocks.install).toHaveBeenCalledTimes(installs + 1);
    expect(options().reference.height).toBe(200);
  });
});
