import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({history: vi.fn(), legacy: vi.fn()}));
vi.mock('../../../src/sync/dust-history.js', () => ({dustHistoryBefore: mocks.history}));
vi.mock('../../../src/sync/preseed.js', async importOriginal => ({
  ...await importOriginal<object>(), ensureEmptyRefCache: mocks.legacy,
}));
// Stop immediately after the real seeding path has written its caches, before
// starting any SDK/network sync. The seeding transform and store are real.
vi.mock('../../../src/sync/sdk-dedup.js', () => ({
  dedupingShieldedBuilder: () => {throw new Error('seeding checked');},
  dedupingDustBuilder: vi.fn(),
}));

import {startWalletSync, type WalletSyncOptions} from '../../../src/sync/wallet-sync.js';
import {deriveWalletKeys} from '../../../src/sync/operations.js';
import {InMemorySyncStateStore, syncStateKey} from '../../../src/sync/sync-store.js';
import type {NetworkConfig} from '../../../src/types/network.js';

const part = (name: string) => gunzipSync(readFileSync(new URL(
  `../../../../extension/public/preseed/preview/${name}.dat.gz`, import.meta.url,
))).toString();
const reference = {height: 200, shielded: part('shielded'), unshielded: part('unshielded'), dust: part('dust')};
const keys = deriveWalletKeys('01'.repeat(32));
const network: NetworkConfig = {id: 'preview', indexerUrl: 'https://indexer.invalid/graphql', nodeUrl: 'https://node.invalid', prover: {type: 'wasm'}};
const key = (part: 'shielded' | 'unshielded' | 'dust') => syncStateKey('preview', 'wallet', part);
async function seed(store: InMemorySyncStateStore, birthday?: number, options: WalletSyncOptions = {reference}) {
  await expect(startWalletSync(keys, network, undefined, 'wallet', false, birthday, {syncStore: store, ...options}))
    .rejects.toThrow('seeding checked');
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.history.mockResolvedValue({kind: 'none'});
  mocks.legacy.mockResolvedValue(reference);
});

describe('versioned references with DUST-history eligibility', () => {
  it.each([undefined, 150])('seeds only DUST for birthday %s after an empty history result', async birthday => {
    const store = new InMemorySyncStateStore();
    await seed(store, birthday);
    expect(mocks.history).toHaveBeenCalledWith(expect.anything(), network.indexerUrl, expect.stringContaining('mn_dust_'), 200);
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(await store.get(key('dust'))).not.toBeNull();
    expect(await store.get(key('shielded'))).toBeNull();
    expect(await store.get(key('unshielded'))).toBeNull();
  });

  it.each([{kind: 'some', entries: 1}, {kind: 'unknown', reason: 'unreadable response'}])('leaves all parts unseeded on $kind history', async verdict => {
    const store = new InMemorySyncStateStore();
    mocks.history.mockResolvedValue(verdict);
    await seed(store);
    for (const part of ['shielded', 'unshielded', 'dust'] as const) expect(await store.get(key(part))).toBeNull();
  });

  it('preserves cached shielded and unshielded state during a DUST-only recovery', async () => {
    const store = new InMemorySyncStateStore();
    await store.put(key('shielded'), 'existing-shielded');
    await store.put(key('unshielded'), 'existing-unshielded');
    await seed(store);
    expect(await store.get(key('shielded'))).toBe('existing-shielded');
    expect(await store.get(key('unshielded'))).toBe('existing-unshielded');
    expect(await store.get(key('dust'))).not.toBeNull();
  });

  it('seeds all missing parts from a birthday-compatible reference without a history query', async () => {
    const store = new InMemorySyncStateStore();
    await seed(store, 250);
    for (const part of ['shielded', 'unshielded', 'dust'] as const) expect(await store.get(key(part))).not.toBeNull();
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it('keeps the CLI legacy lookup when no host reference option is provided', async () => {
    const store = new InMemorySyncStateStore();
    await seed(store, undefined, {});
    expect(mocks.legacy).toHaveBeenCalledOnce();
    expect(await store.get(key('dust'))).not.toBeNull();
  });

  it('does not bypass an explicit null reference with the legacy lookup', async () => {
    const store = new InMemorySyncStateStore();
    await seed(store, undefined, {reference: null});
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
    expect(await store.get(key('dust'))).toBeNull();
  });

  it('does not probe history or replace DUST when its cache already exists', async () => {
    const store = new InMemorySyncStateStore();
    await store.put(key('dust'), 'existing-dust');
    await seed(store);
    expect(mocks.history).not.toHaveBeenCalled();
    expect(await store.get(key('dust'))).toBe('existing-dust');
    expect(await store.get(key('shielded'))).toBeNull();
  });
});
