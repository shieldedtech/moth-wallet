// The warm pool keeps live facades parked so a wallet switch is a re-subscribe
// rather than a rebuild. These tests pin the parts that are dangerous to get
// wrong: ownership (never two owners of one facade), the LRU bound, the
// pass-through behaviour at capacity 0, and the evictions that everything
// freeing key material or clearing stored state depends on.

import { describe, expect, it, vi } from 'vitest';
import { WarmSyncPool, warmPoolKey } from '../../../src/sync/warm-pool.js';
import type { SyncedWallet } from '../../../src/sync/wallet-sync.js';

const NETWORK = { id: 'devnet', nodeUrl: 'ws://node', indexerUrl: 'http://indexer' };

function fakeWallet(): SyncedWallet & { stopped: () => number } {
  let stops = 0;
  return {
    facade: {} as SyncedWallet['facade'],
    balances: {} as SyncedWallet['balances'],
    stop: async () => { stops++; },
    refresh: async () => ({}) as SyncedWallet['balances'],
    subscribe: () => () => {},
    stopped: () => stops,
  } as SyncedWallet & { stopped: () => number };
}

describe('warmPoolKey', () => {
  it('separates wallets on the same network', () => {
    expect(warmPoolKey('alice', NETWORK)).not.toBe(warmPoolKey('bob', NETWORK));
  });

  it('separates the same wallet across networks', () => {
    expect(warmPoolKey('alice', NETWORK)).not.toBe(
      warmPoolKey('alice', { ...NETWORK, id: 'preview' }),
    );
  });

  // A facade is built against specific endpoints. Reusing one after an override
  // changes would keep talking to the endpoints the user just replaced.
  it('separates entries built against different endpoints', () => {
    expect(warmPoolKey('alice', NETWORK)).not.toBe(
      warmPoolKey('alice', { ...NETWORK, indexerUrl: 'http://other' }),
    );
    expect(warmPoolKey('alice', NETWORK, 'server:http://a')).not.toBe(
      warmPoolKey('alice', NETWORK, 'wasm'),
    );
  });
});

describe('WarmSyncPool', () => {
  it('is a pass-through at capacity 0: parking stops rather than keeps', async () => {
    const pool = new WarmSyncPool(0);
    const w = fakeWallet();
    const key = warmPoolKey('alice', NETWORK);

    pool.park(key, w, 'alice', 'devnet');
    await pool.drain();

    expect(pool.size).toBe(0);
    expect(w.stopped()).toBe(1);
    expect(pool.take(key)).toBeUndefined();
  });

  it('returns a parked facade without stopping it', async () => {
    const pool = new WarmSyncPool(1);
    const w = fakeWallet();
    const key = warmPoolKey('alice', NETWORK);

    pool.park(key, w, 'alice', 'devnet');
    expect(pool.size).toBe(1);

    expect(pool.take(key)).toBe(w);
    expect(w.stopped()).toBe(0);
  });

  // Two owners would each subscribe and each stop it. take() must hand over.
  it('hands over ownership — a taken facade is no longer pooled', () => {
    const pool = new WarmSyncPool(2);
    const w = fakeWallet();
    const key = warmPoolKey('alice', NETWORK);

    pool.park(key, w, 'alice', 'devnet');
    expect(pool.take(key)).toBe(w);
    expect(pool.take(key)).toBeUndefined();
    expect(pool.size).toBe(0);
  });

  it('evicts least-recently-parked first past capacity', async () => {
    const pool = new WarmSyncPool(2);
    const a = fakeWallet(), b = fakeWallet(), c = fakeWallet();
    const keyA = warmPoolKey('a', NETWORK), keyB = warmPoolKey('b', NETWORK), keyC = warmPoolKey('c', NETWORK);

    pool.park(keyA, a, 'a', 'devnet');
    pool.park(keyB, b, 'b', 'devnet');
    pool.park(keyC, c, 'c', 'devnet');
    await pool.drain();

    expect(pool.size).toBe(2);
    expect(a.stopped()).toBe(1);
    expect(pool.take(keyA)).toBeUndefined();
    expect(pool.take(keyB)).toBe(b);
    expect(pool.take(keyC)).toBe(c);
  });

  it('re-parking refreshes recency', async () => {
    const pool = new WarmSyncPool(2);
    const a = fakeWallet(), b = fakeWallet(), c = fakeWallet();
    const keyA = warmPoolKey('a', NETWORK), keyB = warmPoolKey('b', NETWORK), keyC = warmPoolKey('c', NETWORK);

    pool.park(keyA, a, 'a', 'devnet');
    pool.park(keyB, b, 'b', 'devnet');
    // Take A back out and return it: it is now the most recent, so B goes first.
    pool.take(keyA);
    pool.park(keyA, a, 'a', 'devnet');
    pool.park(keyC, c, 'c', 'devnet');
    await pool.drain();

    expect(b.stopped()).toBe(1);
    expect(a.stopped()).toBe(0);
    expect(pool.take(keyA)).toBe(a);
  });

  it('lowering capacity stops the excess immediately', async () => {
    const pool = new WarmSyncPool(3);
    const a = fakeWallet(), b = fakeWallet();
    pool.park(warmPoolKey('a', NETWORK), a, 'a', 'devnet');
    pool.park(warmPoolKey('b', NETWORK), b, 'b', 'devnet');

    pool.setCapacity(0);
    await pool.drain();

    expect(pool.size).toBe(0);
    expect(a.stopped()).toBe(1);
    expect(b.stopped()).toBe(1);
  });

  // lockOne(name) zeroes that wallet's keys in WASM. Every facade holding them
  // has to be down first, on every network it is parked for.
  it('evictWallet stops that wallet everywhere by default', async () => {
    const pool = new WarmSyncPool(4);
    const devnet = fakeWallet(), preview = fakeWallet(), other = fakeWallet();
    pool.park(warmPoolKey('alice', NETWORK), devnet, 'alice', 'devnet');
    pool.park(warmPoolKey('alice', { ...NETWORK, id: 'preview' }), preview, 'alice', 'preview');
    pool.park(warmPoolKey('bob', NETWORK), other, 'bob', 'devnet');

    await pool.evictWallet('alice');

    expect(devnet.stopped()).toBe(1);
    expect(preview.stopped()).toBe(1);
    expect(other.stopped()).toBe(0);
    expect(pool.size).toBe(1);
  });

  it('evictWallet can be scoped to one network', async () => {
    const pool = new WarmSyncPool(4);
    const devnet = fakeWallet(), preview = fakeWallet();
    pool.park(warmPoolKey('alice', NETWORK), devnet, 'alice', 'devnet');
    pool.park(warmPoolKey('alice', { ...NETWORK, id: 'preview' }), preview, 'alice', 'preview');

    await pool.evictWallet('alice', 'devnet');

    expect(devnet.stopped()).toBe(1);
    expect(preview.stopped()).toBe(0);
    expect(pool.size).toBe(1);
  });

  it('evictAll stops everything and waits for it', async () => {
    const pool = new WarmSyncPool(3);
    const a = fakeWallet(), b = fakeWallet();
    pool.park(warmPoolKey('a', NETWORK), a, 'a', 'devnet');
    pool.park(warmPoolKey('b', NETWORK), b, 'b', 'devnet');

    await pool.evictAll();

    expect(pool.size).toBe(0);
    expect(a.stopped()).toBe(1);
    expect(b.stopped()).toBe(1);
  });

  // Quitting must not hang on a facade whose stop never settles.
  it('drain gives up at the deadline', async () => {
    vi.useFakeTimers();
    try {
      const pool = new WarmSyncPool(1);
      const hung: SyncedWallet = {
        ...fakeWallet(),
        stop: () => new Promise<void>(() => {}),
      };
      pool.park(warmPoolKey('a', NETWORK), hung, 'a', 'devnet');

      const evicted = pool.evictAll(1_000);
      const settled = vi.fn();
      void evicted.then(settled);

      await vi.advanceTimersByTimeAsync(1_100);
      await evicted;
      expect(settled).toHaveBeenCalled();
      expect(pool.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // A stop that throws must not leave the drain hanging or the entry behind.
  it('survives a facade whose stop rejects', async () => {
    const pool = new WarmSyncPool(1);
    const broken: SyncedWallet = {
      ...fakeWallet(),
      stop: async () => { throw new Error('teardown failed'); },
    };
    pool.park(warmPoolKey('a', NETWORK), broken, 'a', 'devnet');

    await expect(pool.evictAll()).resolves.toBeUndefined();
    expect(pool.size).toBe(0);
  });
});
