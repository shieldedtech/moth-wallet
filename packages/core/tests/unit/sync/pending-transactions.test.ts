// The facade's pending-transaction list is what releases coins a failed
// transaction booked, and it used to be lost on restart while the booked coins
// were restored from cache (#208). These pin its save → restore round trip.

import {describe, expect, it} from 'vitest';
import {DateTime, Either, Option} from 'effect';
import * as Rx from 'rxjs';
import {ProtocolVersion} from '@midnightntwrk/wallet-sdk';
import {PendingTransactions} from '@midnightntwrk/wallet-sdk/capabilities/pendingTransactions';
import {
  makePendingTransactionsService,
  restorePendingState,
  serializePendingTransactions,
} from '../../../src/sync/pending-transactions.js';
import {clearSyncCache} from '../../../src/sync/wallet-sync.js';
import {InMemorySyncStateStore, syncStateKey} from '../../../src/sync/sync-store.js';

type Era = 'v8' | 'v9';

/** Stands in for a finalized transaction of one ledger version: its bytes are its identity. */
class FakeTx {
  constructor(
    readonly era: Era,
    readonly bytes: Uint8Array
  ) {}
  get id(): string {
    return Array.from(this.bytes).join('.');
  }
}

const V8 = ProtocolVersion.MinSupportedVersion;
const FORK = ProtocolVersion.ProtocolVersion(9_000_000n);

/** One trait per ledger version, each refusing the other's transactions, as the facade's are. */
const traitFor = (era: Era): PendingTransactions.TransactionTrait<FakeTx> => ({
  ids: (tx) => [tx.id],
  firstId: (tx) => tx.id,
  areAllTxIdsIncluded: (tx, ids) => ids.includes(tx.id),
  isOneIncludedInOther: (a, b) => a.id === b.id,
  hasTTLExpired: () => false,
  serialize: (tx) => tx.bytes,
  deserialize: (bytes) => new FakeTx(era, bytes),
  isTx: (tx): tx is FakeTx => tx instanceof FakeTx && tx.era === era,
});

const traits = Either.getOrThrow(
  ProtocolVersion.makeRegistryFromActivations([
    {sinceVersion: V8, value: traitFor('v8')},
    {sinceVersion: FORK, value: traitFor('v9')},
  ])
);

const now = DateTime.unsafeNow();

function watching(...txs: Array<[FakeTx, ProtocolVersion.ProtocolVersion]>) {
  let state = PendingTransactions.empty<FakeTx>();
  for (const [tx, version] of txs) {
    state = PendingTransactions.addPendingTransaction(state, tx, now, traits, Option.some(version));
  }
  return state;
}

const reservation: PendingTransactions.Reservation = {
  identifiers: ['booked'],
  intentHashes: [],
  inputs: {unshielded: ['coin-1']},
  ttl: new Date(Date.now() + 60_000),
  createdAt: now,
  expired: false,
};

describe('pending transactions cache', () => {
  it('restores every watched transaction byte for byte, with the version it was authored for', () => {
    const before = new FakeTx('v8', new Uint8Array([0, 1, 255]));
    const after = new FakeTx('v9', new Uint8Array([16, 32]));
    const raw = serializePendingTransactions(watching([before, V8], [after, FORK]), traits);
    expect(raw).not.toBeNull();

    const restored = restorePendingState(raw!, traits);
    expect(restored?.all.map((item) => [item.tx.era, item.tx.id, Option.getOrNull(item.protocolVersion)])).toEqual([
      ['v8', before.id, V8],
      ['v9', after.id, FORK],
    ]);
  });

  it('keeps the version stamp, so a restored pre-fork transaction is orphaned once the wallets cross', () => {
    const stranded = new FakeTx('v8', new Uint8Array([7]));
    const restored = restorePendingState(serializePendingTransactions(watching([stranded, V8]), traits)!, traits)!;
    const crossed = PendingTransactions.orphanBeyond(restored, traits, FORK);
    expect(PendingTransactions.allOrphaned(crossed).map((item) => item.tx.id)).toEqual([stranded.id]);
  });

  it('saves the reservations of balanced-but-unsubmitted spends', () => {
    const state = PendingTransactions.addReservation(PendingTransactions.empty<FakeTx>(), reservation);
    const raw = serializePendingTransactions(state, traits);
    expect(raw).not.toBeNull();
    expect(restorePendingState(raw!, traits)?.reservations.map((r) => r.identifiers)).toEqual([['booked']]);
  });

  it('saves nothing when no transaction is in flight', () => {
    expect(serializePendingTransactions(PendingTransactions.empty<FakeTx>(), traits)).toBeNull();
  });

  it('ignores a payload it cannot read', () => {
    expect(restorePendingState('not-json', traits)).toBeUndefined();
    expect(restorePendingState('null', traits)).toBeUndefined();
    // The pre-SDK-2.0 format: its coins wait for a resync, as before the list was saved.
    expect(restorePendingState(JSON.stringify({version: 1, transactions: ['00']}), traits)).toBeUndefined();
  });

  it('seeds the facade service with the saved list, and starts empty without one', async () => {
    const tx = new FakeTx('v9', new Uint8Array([3, 4]));
    const configuration = {indexerClientConnection: {indexerHttpUrl: 'http://127.0.0.1:1'}};
    const raw = serializePendingTransactions(watching([tx, FORK]), traits);

    const seeded = await makePendingTransactionsService(raw, traits, configuration);
    const fresh = await makePendingTransactionsService('not-json', traits, configuration);
    expect((await Rx.firstValueFrom(seeded.state())).all.map((item) => item.tx.id)).toEqual([tx.id]);
    expect((await Rx.firstValueFrom(fresh.state())).all).toEqual([]);
  });

  it('is evicted alongside the wallet parts by clearSyncCache', async () => {
    const store = new InMemorySyncStateStore();
    const key = syncStateKey('devnet', 'alice', 'pending');
    await store.put(key, '{"version":"v1","transactions":[]}');
    await clearSyncCache('alice', 'devnet', store);
    expect(await store.get(key)).toBeNull();
  });
});

// The fix leans on the SDK treating a restored transaction as unresolved, so it
// is polled again, and on it reverting partial successes as well as failures.
describe('wallet SDK pending-transaction contract', () => {
  it('polls a restored transaction for its status', () => {
    const tx = new FakeTx('v9', new Uint8Array([1]));
    const restored = restorePendingState(serializePendingTransactions(watching([tx, FORK]), traits)!, traits)!;
    expect(PendingTransactions.allPending(restored).map((item) => item.tx.id)).toEqual([tx.id]);
  });

  it('reverts a transaction whose result is a partial success or a failure', () => {
    const partial = new FakeTx('v9', new Uint8Array([2]));
    const failed = new FakeTx('v9', new Uint8Array([3]));
    let state = watching([partial, FORK], [failed, FORK]);
    state = PendingTransactions.saveResult(state, partial, {status: 'PARTIAL_SUCCESS', segments: []}, traits);
    state = PendingTransactions.saveResult(state, failed, {status: 'FAILURE', segments: []}, traits);
    expect(PendingTransactions.allFailed(state).map((item) => item.tx.id)).toEqual([partial.id, failed.id]);
  });
});
