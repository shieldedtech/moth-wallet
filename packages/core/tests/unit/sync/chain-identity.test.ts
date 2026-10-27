// A wallet's cached sync state is chain state keyed by network name alone, so a local network
// brought back from genesis under the same name would be restored onto the new chain. The
// genesis hash recorded beside the cache is what tells the two apart; this pins the verdict and
// what the reconciliation does to the store on each of them.

import {beforeEach, describe, expect, it} from 'vitest';
import {cacheChainVerdict, reconcileCacheChain, type CacheChainVerdict} from '../../../src/sync/chain-identity.js';
import {InMemorySyncStateStore, chainIdentityKey, syncStateKey} from '../../../src/sync/sync-store.js';

const NETWORK = 'undeployed';
const WALLET = 'alice';
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

describe('cacheChainVerdict', () => {
  it('keeps a cache written on the live chain', () => {
    expect(cacheChainVerdict(OLD, OLD)).toEqual({kind: 'kept', current: OLD});
  });

  it('stamps a cache that predates the stamp', () => {
    expect(cacheChainVerdict(null, NEW)).toEqual({kind: 'stamped', current: NEW});
    expect(cacheChainVerdict('', NEW)).toEqual({kind: 'stamped', current: NEW});
  });

  it('replaces a cache another chain wrote', () => {
    expect(cacheChainVerdict(OLD, NEW)).toEqual({kind: 'replaced', previous: OLD, current: NEW});
  });

  it('decides nothing when the chain could not be asked', () => {
    expect(cacheChainVerdict(OLD, undefined)).toEqual({kind: 'unknown'});
    expect(cacheChainVerdict(null, undefined)).toEqual({kind: 'unknown'});
  });
});

describe('reconcileCacheChain', () => {
  let store: InMemorySyncStateStore;
  let evicted: CacheChainVerdict[];
  const key = chainIdentityKey(NETWORK, WALLET);
  const reconcile = (live: string | undefined) =>
    reconcileCacheChain({
      store,
      walletName: WALLET,
      networkId: NETWORK,
      live,
      evict: async (verdict) => {
        evicted.push(verdict);
        await store.delete(syncStateKey(NETWORK, WALLET, 'dust'));
      },
    });

  beforeEach(async () => {
    store = new InMemorySyncStateStore();
    evicted = [];
    await store.put(syncStateKey(NETWORK, WALLET, 'dust'), 'dust-state');
  });

  it('evicts and re-stamps on a replaced chain', async () => {
    await store.put(key, OLD);
    expect(await reconcile(NEW)).toEqual({kind: 'replaced', previous: OLD, current: NEW});
    expect(evicted).toEqual([{kind: 'replaced', previous: OLD, current: NEW}]);
    expect(await store.get(syncStateKey(NETWORK, WALLET, 'dust'))).toBeNull();
    expect(await store.get(key)).toBe(NEW);
  });

  it('stamps an unstamped cache and keeps it', async () => {
    expect(await reconcile(NEW)).toEqual({kind: 'stamped', current: NEW});
    expect(evicted).toEqual([]);
    expect(await store.get(syncStateKey(NETWORK, WALLET, 'dust'))).toBe('dust-state');
    expect(await store.get(key)).toBe(NEW);
  });

  it('touches nothing on the same chain, or when the chain is unknown', async () => {
    await store.put(key, OLD);
    expect(await reconcile(OLD)).toEqual({kind: 'kept', current: OLD});
    expect(await reconcile(undefined)).toEqual({kind: 'unknown'});
    expect(evicted).toEqual([]);
    expect(await store.get(syncStateKey(NETWORK, WALLET, 'dust'))).toBe('dust-state');
    expect(await store.get(key)).toBe(OLD);
  });

  it('leaves the old stamp when the eviction fails, so the next start evicts again', async () => {
    await store.put(key, OLD);
    await expect(
      reconcileCacheChain({
        store,
        walletName: WALLET,
        networkId: NETWORK,
        live: NEW,
        evict: () => Promise.reject(new Error('store closed')),
      }),
    ).rejects.toThrow('store closed');
    expect(await store.get(key)).toBe(OLD);
  });

  it('is scoped to one wallet on one network', async () => {
    await store.put(key, OLD);
    await store.put(chainIdentityKey('preprod', WALLET), OLD);
    await store.put(chainIdentityKey(NETWORK, 'bob'), OLD);
    await reconcile(NEW);
    expect(await store.get(chainIdentityKey('preprod', WALLET))).toBe(OLD);
    expect(await store.get(chainIdentityKey(NETWORK, 'bob'))).toBe(OLD);
  });
});
