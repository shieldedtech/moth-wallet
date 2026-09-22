// The dust view check against a cached snapshot, with no sync running.
//
// A daemon or TUI checks its live view (SyncedWallet.checkDustView). When
// nothing is running — the wallet is stopped, or a bot is refusing to start into
// a cache that looks wrong — the cached `dust.dat` can still be read and compared
// with the chain, which is exactly what took an afternoon by hand on 2026-09-22.

import * as ledger from '@midnight-ntwrk/ledger-v8';
import {IndexerClient} from '../network/indexer-client.js';
import {fetchDustGenerations, readDustTip} from './dust-generations.js';
import {assessDustView, localDustCoins, type DustViewHealth, type LocalDustCoin} from './dust-view.js';
import {resolveSyncStore} from './wallet-sync.js';
import {syncStateKey, type SyncStateStore} from './sync-store.js';

export interface CachedDustSnapshot {
  /** The dust cursor stored with the snapshot (`offset`). */
  readonly appliedIndex: number | null;
  readonly coins: readonly LocalDustCoin[];
  /** Time of the last event the state applied. */
  readonly syncTime: Date | null;
  /** Balance the state computes for `now`, in SPECK. */
  readonly balance: bigint | null;
}

/** Decode a serialized dust snapshot (the SDK's JSON form) into what the check needs. */
export function readCachedDustSnapshot(serialized: string, now = new Date()): CachedDustSnapshot {
  const snap = JSON.parse(serialized) as {state?: string; offset?: string | number};
  if (typeof snap.state !== 'string') throw new Error('dust snapshot has no state');
  const state = ledger.DustLocalState.deserialize(Buffer.from(snap.state, 'hex'));
  let balance: bigint | null = null;
  try {
    balance = state.walletBalance(now);
  } catch {
    balance = null;
  }
  const offset = snap.offset === undefined ? null : Number(snap.offset);
  return {
    appliedIndex: offset !== null && Number.isFinite(offset) ? offset : null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    coins: localDustCoins(state as any),
    syncTime: state.syncTime instanceof Date ? state.syncTime : null,
    balance,
  };
}

export interface OfflineDustCheck {
  readonly snapshot: CachedDustSnapshot | null;
  readonly dustView: DustViewHealth;
}

/**
 * Compare a wallet's cached dust view with the chain. `snapshot` is null when
 * the wallet has no dust cache, in which case every live entry is missing — a
 * true statement about the view, and what a fresh sync will fix.
 */
export async function checkCachedDustView(opts: {
  walletName: string;
  networkId: string;
  indexerUrl: string;
  dustAddress: string;
  store?: SyncStateStore;
  now?: number;
}): Promise<OfflineDustCheck> {
  const now = opts.now ?? Date.now();
  const store = await resolveSyncStore(opts.store);
  const serialized = await store.get(syncStateKey(opts.networkId, opts.walletName, 'dust'));
  const snapshot = serialized ? readCachedDustSnapshot(serialized, new Date(now)) : null;

  const indexer = new IndexerClient(opts.indexerUrl);
  const block = await indexer.getBlock();
  const end = block ? await indexer.getDustGenerationEndIndex(block.height) : null;
  if (end === null) throw new Error('indexer does not report the generation tree size at the tip');
  const localApplied = snapshot?.appliedIndex ?? null;
  const [gens, tip] = await Promise.all([
    fetchDustGenerations(opts.indexerUrl, opts.dustAddress, end),
    localApplied === null ? Promise.resolve(null) : readDustTip(opts.indexerUrl, localApplied).catch(() => null),
  ]);
  // Offline there is no earlier verdict to age a missing coin against, so the
  // grace is zero: a cache with a live entry and no coin is incomplete now.
  const dustView = assessDustView({
    now,
    live: gens.live,
    localCoins: snapshot?.coins ?? [],
    localApplied,
    indexerMaxId: tip?.maxId ?? null,
    missingGraceMs: 0,
  });
  return {snapshot, dustView};
}
