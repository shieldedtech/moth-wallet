// The facade's lifecycle records are what release coins a failed transaction
// booked, and they used to be lost on restart while the booked coins were
// restored from cache (#208). These pin their save → restore round trip, and
// that the list earlier builds saved under the same key still reads.

import {describe, expect, it} from 'vitest';
import {Either, Option} from 'effect';
import * as Rx from 'rxjs';
import {ProtocolVersion} from '@midnightntwrk/wallet-sdk';
import {
  Lifecycle,
  type TransactionTraits,
} from '@midnightntwrk/wallet-sdk/capabilities/transactionLifecycle';
import {makeTransactionLifecycleService} from '../../../src/sync/transaction-lifecycle.js';
import {clearSyncCache} from '../../../src/sync/wallet-sync.js';
import {InMemorySyncStateStore, syncStateKey} from '../../../src/sync/sync-store.js';

type Era = 'v8' | 'v9';

/** Stands in for a transaction of one ledger version: its bytes are its identity. */
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
const FAR_FUTURE = new Date('2100-01-01T00:00:00Z');

/** One trait per ledger version, each refusing the other's transactions, as the facade's are. */
const traitFor = (era: Era): TransactionTraits.TransactionTrait<FakeTx> => ({
  ids: (tx) => [tx.id],
  firstId: (tx) => tx.id,
  areAllTxIdsIncluded: (tx, ids) => ids.includes(tx.id),
  intentHashes: () => [],
  inputs: () => ({unshielded: []}),
  ttl: () => FAR_FUTURE,
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

const configuration = {indexerClientConnection: {indexerHttpUrl: 'http://127.0.0.1:1'}};

/**
 * What wallet-sdk 2.0.0-canary.20261102170246-27e8969 wrote for two watched
 * transactions, one per ledger version, and one balanced-but-unsubmitted spend:
 * the pending-transactions format moth saved under the 'pending' key.
 */
const PENDING_LIST_V1 = JSON.stringify({
  version: 'v1',
  transactions: [
    {tx: '0001ff', creationTime: '2026-11-01T12:00:00.000Z', protocolVersion: '0'},
    {tx: '1020', creationTime: '2026-11-01T12:00:00.000Z', protocolVersion: '9000000'},
  ],
  reservations: [
    {
      identifiers: ['booked'],
      intentHashes: ['intent-1'],
      inputs: {unshielded: ['intent-0#0']},
      ttl: '2100-01-01T00:00:00.000Z',
      createdAt: '2026-11-01T12:00:00.000Z',
      expired: false,
    },
  ],
});

const facts = (tx: FakeTx, protocolVersion: ProtocolVersion.ProtocolVersion) => ({
  tx,
  identifiers: [tx.id],
  intentHashes: [],
  inputs: {unshielded: []},
  ttl: FAR_FUTURE,
  protocolVersion,
});

const recordsOf = async (service: {state: () => Rx.Observable<Lifecycle.TransactionLifecycle<FakeTx>>}) =>
  (await Rx.firstValueFrom(service.state())).records;

const summary = (record: Lifecycle.LifecycleRecord<FakeTx>) => [
  record.state._tag,
  Option.getOrNull(Option.map(record.tx, (tx) => `${tx.era}:${tx.id}`)),
  Option.getOrNull(record.protocolVersion),
];

describe('transaction lifecycle cache', () => {
  it('reads the pending list an earlier build saved back as records', async () => {
    const service = await makeTransactionLifecycleService(PENDING_LIST_V1, traits, configuration);
    expect((await recordsOf(service)).map(summary)).toEqual([
      ['Submitted', 'v8:0.1.255', V8],
      ['Submitted', 'v9:16.32', FORK],
      ['Balanced', null, null],
    ]);
  });

  it('restores every record it saved, with the version its transaction was built for', async () => {
    const before = new FakeTx('v8', new Uint8Array([0, 1, 255]));
    const after = new FakeTx('v9', new Uint8Array([16, 32]));
    const live = await makeTransactionLifecycleService(null, traits, configuration);
    await live.submitted(facts(before, V8));
    await live.submitted(facts(after, FORK));

    const restored = await makeTransactionLifecycleService(await live.serializeState(), traits, configuration);
    expect((await recordsOf(restored)).map(summary)).toEqual([
      ['Submitted', `v8:${before.id}`, V8],
      ['Submitted', `v9:${after.id}`, FORK],
    ]);
  });

  it('keeps the version stamp, so a restored pre-fork transaction is orphaned once the wallets cross', async () => {
    const restored = await makeTransactionLifecycleService(PENDING_LIST_V1, traits, configuration);
    await restored.orphanBeyond(FORK);
    expect((await recordsOf(restored)).map((record) => record.state._tag)).toEqual([
      'Orphaned',
      'Submitted',
      'Balanced',
    ]);
  });

  it('starts fresh on a store it cannot read, or without one', async () => {
    // The last is the pre-SDK-2.0 format: its coins wait for a resync, as before the list was saved.
    for (const saved of [null, 'not-json', 'null', JSON.stringify({version: 1, transactions: ['00']})]) {
      const service = await makeTransactionLifecycleService(saved, traits, configuration);
      expect(await recordsOf(service)).toEqual([]);
    }
  });

  it('is evicted alongside the wallet parts by clearSyncCache', async () => {
    const store = new InMemorySyncStateStore();
    const key = syncStateKey('devnet', 'alice', 'pending');
    await store.put(key, PENDING_LIST_V1);
    await clearSyncCache('alice', 'devnet', store);
    expect(await store.get(key)).toBeNull();
  });
});

// The fix leans on the SDK treating a restored transaction as unresolved, so its
// status is polled again and the facade can still release what it booked.
describe('wallet SDK lifecycle contract', () => {
  it('keeps a restored submitted transaction live', async () => {
    const restored = await makeTransactionLifecycleService(PENDING_LIST_V1, traits, configuration);
    expect((await recordsOf(restored)).map(Lifecycle.isLive)).toEqual([true, true, true]);
  });
});
