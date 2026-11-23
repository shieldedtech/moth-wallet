// The facade's lifecycle records are what release coins a failed transaction
// booked, and they used to be lost on restart while the booked coins were
// restored from cache (#208). These pin their save → restore round trip, in the
// service and across a restart of wallet sync, and that the list earlier builds
// saved under the same key still reads.

import {afterEach, describe, expect, it} from 'vitest';
import {Either, Option} from 'effect';
import * as Rx from 'rxjs';
import {InMemoryTransactionHistoryStorage, ProtocolVersion} from '@midnightntwrk/wallet-sdk';
import {DustWallet} from '@midnightntwrk/wallet-sdk/dust';
import {
  WalletEntrySchema,
  WalletFacade,
  mergeWalletEntries,
  type DefaultConfiguration,
} from '@midnightntwrk/wallet-sdk/facade';
import {ShieldedWallet} from '@midnightntwrk/wallet-sdk/shielded';
import {UnshieldedWallet, PublicKey, createKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import {
  Lifecycle,
  type TransactionTraits,
} from '@midnightntwrk/wallet-sdk/capabilities/transactionLifecycle';
import {deriveWalletKeys, type WalletKeys} from '../../../src/sync/operations.js';
import {makeTransactionLifecycleService} from '../../../src/sync/transaction-lifecycle.js';
import {clearSyncCache, startWalletSync} from '../../../src/sync/wallet-sync.js';
import {InMemorySyncStateStore, syncStateKey, type WalletPart} from '../../../src/sync/sync-store.js';
import {serverProver, type NetworkConfig} from '../../../src/types/network.js';
import {testSeedHex} from '../../helpers/seed.js';

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

/** A balanced-but-unsubmitted spend, as the pending-transactions list held it. */
const BOOKED_SPEND = {
  identifiers: ['booked'],
  intentHashes: ['intent-1'],
  inputs: {unshielded: ['intent-0#0']},
  ttl: '2100-01-01T00:00:00.000Z',
  createdAt: '2026-11-01T12:00:00.000Z',
  expired: false,
};

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
  reservations: [BOOKED_SPEND],
});

/** The same list holding the booked spend alone, which the facade's own traits can read. */
const BOOKED_SPEND_LIST_V1 = JSON.stringify({version: 'v1', transactions: [], reservations: [BOOKED_SPEND]});

const facts = (tx: FakeTx, protocolVersion: ProtocolVersion.ProtocolVersion) => ({
  tx,
  identifiers: [tx.id],
  intentHashes: [],
  inputs: {unshielded: []},
  ttl: FAR_FUTURE,
  protocolVersion,
});

const recordsOf = async <T>(service: {state: () => Rx.Observable<Lifecycle.TransactionLifecycle<T>>}) =>
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

// Nothing listens on port 9: the wallets start, reach no chain, and keep what they restored.
const OFFLINE: NetworkConfig = {
  id: 'preprod',
  nodeUrl: 'ws://127.0.0.1:9',
  indexerUrl: 'http://127.0.0.1:9/api',
  prover: serverProver('http://127.0.0.1:9'),
};

/** A store holding a fresh wallet's three snapshots, so wallet sync restores it rather than pre-seeding. */
async function cachedWallet(keys: WalletKeys, name: string): Promise<InMemorySyncStateStore> {
  const config = WalletFacade.resolveConfiguration<DefaultConfiguration>({
    networkId: OFFLINE.id,
    indexerClientConnection: {indexerHttpUrl: OFFLINE.indexerUrl, indexerWsUrl: 'ws://127.0.0.1:9/api/ws'},
    relayURL: new URL(OFFLINE.nodeUrl),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: {additionalFeeOverhead: 0n, feeBlocksMargin: 0},
  });
  const wallets: Array<[WalletPart, {serializeState(): Promise<string>; stop(): Promise<void>}]> = [
    ['shielded', await ShieldedWallet(config).startWithSeed(keys.shielded)],
    [
      'unshielded',
      await UnshieldedWallet(config).startWithPublicKey(
        PublicKey.fromKeyStore(createKeystore({kind: 'schnorr', secret: keys.unshielded}, OFFLINE.id))
      ),
    ],
    ['dust', await DustWallet(config).startWithSeed(keys.dust)],
  ];
  const store = new InMemorySyncStateStore();
  for (const [part, wallet] of wallets) {
    await store.put(syncStateKey(OFFLINE.id, name, part), await wallet.serializeState());
    await wallet.stop();
  }
  return store;
}

describe('wallet sync', () => {
  const stoppers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.allSettled(stoppers.splice(0).map((stop) => stop()));
  });

  it('carries a live record across a restart', async () => {
    const keys = deriveWalletKeys(await testSeedHex());
    const store = await cachedWallet(keys, 'alice');
    const pending = syncStateKey(OFFLINE.id, 'alice', 'pending');
    await store.put(pending, BOOKED_SPEND_LIST_V1);

    const session = async () => {
      const sync = await startWalletSync(keys, OFFLINE, undefined, 'alice', false, undefined, {syncStore: store});
      stoppers.push(() => sync.stop());
      return sync;
    };
    const liveStates = async (sync: {facade: WalletFacade}) =>
      (await recordsOf(sync.facade.transactionLifecycleService)).filter(Lifecycle.isLive).map((r) => r.state._tag);

    const first = await session();
    expect(await liveStates(first)).toEqual(['Balanced']);

    // Dropped, so only what the first session saves on stop can hand the record to the second.
    await store.delete(pending);
    await first.stop();

    expect(await liveStates(await session())).toEqual(['Balanced']);
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
