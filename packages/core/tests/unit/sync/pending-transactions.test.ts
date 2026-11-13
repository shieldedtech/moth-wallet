// The facade's pending-transaction list is what releases coins a failed
// transaction booked, and it used to be lost on restart while the booked coins
// were restored from cache (#208). These pin its save → restore round trip.

import {describe, expect, it} from 'vitest';
import {PendingTransactions} from '@midnightntwrk/wallet-sdk/capabilities/pendingTransactions';
import {restorePendingTransactions, serializePendingTransactions} from '../../../src/sync/pending-transactions.js';
import {clearSyncCache} from '../../../src/sync/wallet-sync.js';
import {InMemorySyncStateStore, syncStateKey} from '../../../src/sync/sync-store.js';

/** Stands in for a finalized transaction: its bytes are its identity. */
class FakeTx {
  constructor(readonly bytes: Uint8Array) {}
  get id(): string {
    return Array.from(this.bytes).join('.');
  }
}

const serialize = (tx: FakeTx) => tx.bytes;
const deserialize = (bytes: Uint8Array) => new FakeTx(bytes);

async function restore(raw: string): Promise<FakeTx[]> {
  const added: FakeTx[] = [];
  await restorePendingTransactions(raw, deserialize, async (tx) => {
    added.push(tx);
  });
  return added;
}

describe('pending transactions cache', () => {
  it('restores every watched transaction byte for byte', async () => {
    const txs = [new FakeTx(new Uint8Array([0, 1, 255])), new FakeTx(new Uint8Array([16, 32]))];
    const raw = serializePendingTransactions({all: txs.map((tx) => ({tx}))}, serialize);
    expect(raw).not.toBeNull();
    expect((await restore(raw!)).map((tx) => tx.id)).toEqual(txs.map((tx) => tx.id));
  });

  it('saves nothing when no transaction is in flight', () => {
    expect(serializePendingTransactions({all: []}, serialize)).toBeNull();
  });

  it('skips entries that no longer decode and keeps the rest', async () => {
    const raw = JSON.stringify({version: 1, transactions: ['0a0b', 'zz', 'abc', 7, 'ff']});
    const failing = (bytes: Uint8Array) => {
      if (bytes[0] === 0xff) throw new Error('unknown transaction version');
      return new FakeTx(bytes);
    };
    const added: FakeTx[] = [];
    const count = await restorePendingTransactions(raw, failing, async (tx) => {
      added.push(tx);
    });
    expect(count).toBe(1);
    expect(added.map((tx) => tx.id)).toEqual(['10.11']);
  });

  it('ignores a payload it does not recognise', async () => {
    expect(await restore('not-json')).toEqual([]);
    expect(await restore(JSON.stringify({version: 2, transactions: ['00']}))).toEqual([]);
    expect(await restore('null')).toEqual([]);
  });

  it('is evicted alongside the wallet parts by clearSyncCache', async () => {
    const store = new InMemorySyncStateStore();
    const key = syncStateKey('devnet', 'alice', 'pending');
    await store.put(key, '{"version":1,"transactions":[]}');
    await clearSyncCache('alice', 'devnet', store);
    expect(await store.get(key)).toBeNull();
  });
});

// The fix leans on the SDK treating a re-added transaction as unresolved, so it
// is polled again, and on it reverting partial successes as well as failures.
describe('wallet SDK pending-transaction contract', () => {
  const trait = {
    ids: (tx: FakeTx) => [tx.id],
    isOneIncludedInOther: (a: FakeTx, b: FakeTx) => a.id === b.id,
    areAllTxIdsIncluded: (tx: FakeTx, ids: readonly string[]) => ids.includes(tx.id),
  };
  const now = new Date() as never;

  it('polls a restored transaction for its status', () => {
    const tx = new FakeTx(new Uint8Array([1]));
    const state = PendingTransactions.addPendingTransaction(PendingTransactions.empty(), tx, now, trait as never);
    expect(PendingTransactions.allPending(state as never).map((item: {tx: FakeTx}) => item.tx.id)).toEqual([tx.id]);
  });

  it('reverts a transaction whose result is a partial success or a failure', () => {
    const partial = new FakeTx(new Uint8Array([2]));
    const failed = new FakeTx(new Uint8Array([3]));
    let state = PendingTransactions.empty<FakeTx>();
    for (const tx of [partial, failed]) state = PendingTransactions.addPendingTransaction(state, tx, now, trait as never);
    state = PendingTransactions.saveResult(state, partial, {status: 'PARTIAL_SUCCESS', segments: []}, trait as never);
    state = PendingTransactions.saveResult(state, failed, {status: 'FAILURE', segments: []}, trait as never);
    expect(PendingTransactions.allFailed(state).map((item) => item.tx.id)).toEqual([partial.id, failed.id]);
  });
});
