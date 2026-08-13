// Transaction history persists through the same SyncStateStore as the wallet
// sync state: serialized on the save cadence, restored at engine start, and
// evicted by clearSyncCache. These tests pin the serialize → store → restore
// round trip and the eviction.

import { describe, expect, it } from 'vitest';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk';
import { WalletEntrySchema, mergeWalletEntries, type WalletEntry } from '@midnightntwrk/wallet-sdk/facade';
import { clearSyncCache } from '../../../src/sync/wallet-sync.js';
import { InMemorySyncStateStore, syncStateKey } from '../../../src/sync/sync-store.js';
import { NIGHT_TOKEN_ID } from '../../../src/types/tokens.js';

const HASH = 'f'.repeat(64);

const ENTRY: WalletEntry = {
  hash: HASH,
  protocolVersion: 1,
  status: 'SUCCESS',
  timestamp: new Date('2026-07-12T09:12:00Z'),
  fees: 400n,
  unshielded: {
    id: 7,
    createdUtxos: [
      { value: 120_000_000n, owner: 'mn_addr1own', tokenType: NIGHT_TOKEN_ID, intentHash: 'i'.repeat(64), outputIndex: 0 },
    ],
    spentUtxos: [],
  },
} as WalletEntry;

function makeStorage() {
  return new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries);
}

describe('transaction history cache', () => {
  it('survives a serialize → store → restore round trip with bigints and dates intact', async () => {
    const storage = makeStorage();
    await storage.upsert(ENTRY);

    const store = new InMemorySyncStateStore();
    const key = syncStateKey('devnet', 'alice', 'history');
    await store.put(key, await storage.serialize());

    const saved = await store.get(key);
    expect(saved).not.toBeNull();
    const restored = InMemoryTransactionHistoryStorage.restore(saved!, WalletEntrySchema, mergeWalletEntries);

    expect(await restored.getAll()).toEqual([ENTRY]);
  });

  it('merges re-applied sections after a restore instead of duplicating them', async () => {
    const storage = makeStorage();
    await storage.upsert(ENTRY);
    const restored = InMemoryTransactionHistoryStorage.restore(
      await storage.serialize(),
      WalletEntrySchema,
      mergeWalletEntries,
    );

    // Catch-up sync re-reports the same transaction (same section content) and
    // adds the section another sub-wallet contributes.
    await restored.upsert(ENTRY);
    await restored.upsert({
      hash: HASH,
      protocolVersion: 1,
      status: 'SUCCESS',
      shielded: { receivedCoins: [{ type: 'musd0000', nonce: 'n', value: 5n, mtIndex: 1n }], spentCoins: [] },
    } as WalletEntry);

    const all = await restored.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.unshielded?.createdUtxos).toHaveLength(1);
    expect(all[0]?.shielded?.receivedCoins).toHaveLength(1);
  });

  it('rejects a corrupted cache payload so callers can evict and rebuild', () => {
    expect(() =>
      InMemoryTransactionHistoryStorage.restore('not-json', WalletEntrySchema, mergeWalletEntries),
    ).toThrow();
  });

  it('is evicted alongside the wallet parts by clearSyncCache', async () => {
    const store = new InMemorySyncStateStore();
    const key = syncStateKey('devnet', 'alice', 'history');
    await store.put(key, '[]');
    await store.put(syncStateKey('devnet', 'alice', 'shielded'), 'x');

    await clearSyncCache('alice', 'devnet', store);

    expect(await store.get(key)).toBeNull();
    expect(await store.get(syncStateKey('devnet', 'alice', 'shielded'))).toBeNull();
  });
});
