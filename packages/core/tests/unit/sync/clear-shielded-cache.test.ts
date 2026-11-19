import { describe, it, expect } from 'vitest';
import { clearShieldedSyncCache } from '../../../src/sync/wallet-sync.js';
import { InMemorySyncStateStore, syncStateKey, type WalletPart } from '../../../src/sync/sync-store.js';

const PARTS: WalletPart[] = ['shielded', 'unshielded', 'dust', 'history'];

// The point of a shielded-only clear is what it keeps: DUST is by far the slowest
// part to rebuild, and clearing it here would turn a minutes-long repair into an hour.
describe('clearShieldedSyncCache', () => {
  it('evicts the shielded state and keeps every other part', async () => {
    const store = new InMemorySyncStateStore();
    for (const part of PARTS) await store.put(syncStateKey('preprod', 'alice', part), part);

    await clearShieldedSyncCache('alice', 'preprod', store);

    expect(await store.get(syncStateKey('preprod', 'alice', 'shielded'))).toBeNull();
    for (const part of PARTS.filter((p) => p !== 'shielded')) {
      expect(await store.get(syncStateKey('preprod', 'alice', part))).toBe(part);
    }
  });

  it('touches only the named wallet on the named network', async () => {
    const store = new InMemorySyncStateStore();
    await store.put(syncStateKey('preprod', 'bob', 'shielded'), 'x');
    await store.put(syncStateKey('preview', 'alice', 'shielded'), 'y');

    await clearShieldedSyncCache('alice', 'preprod', store);

    expect(await store.get(syncStateKey('preprod', 'bob', 'shielded'))).toBe('x');
    expect(await store.get(syncStateKey('preview', 'alice', 'shielded'))).toBe('y');
  });
});
