// Whether a wallet's cached sync state belongs to the chain the indexer serves now. The cache is
// chain state (coins, trees, cursors) keyed by network name alone, therefore a local network
// brought back from genesis under the same name would restore the old chain's state onto the
// new one; a chain is named by the hash of its block 1, recorded beside the cache and compared
// before a restore. The genesis block is the chainspec's, so every run of a local network has the
// same one, but block 1 is the first block with the run's own timestamp and its parent is the
// genesis, therefore its hash names the run and the chainspec both. WASM-free like progress.ts,
// so it is unit-tested without the wallet SDK.

import {IndexerClient} from '../network/indexer-client.js';
import {chainIdentityKey, type SyncStateStore} from './sync-store.js';

/** What a comparison of the stored chain against the live one decided. */
export type CacheChainVerdict =
  /** The cache was written on this chain. */
  | {kind: 'kept'; current: string}
  /** The cache predates the stamp; it is taken to be this chain's, as a capsule snapshot without a genesis is. */
  | {kind: 'stamped'; current: string}
  /** Another chain wrote the cache: it must not be restored. */
  | {kind: 'replaced'; previous: string; current: string}
  /** The chain could not be asked; the cache is kept, as it is when the indexer is down at any other time. */
  | {kind: 'unknown'};

/** The block whose hash names a chain: the first with the run's own timestamp. */
export const CHAIN_IDENTITY_HEIGHT = 1;

/**
 * The chain's identity at the indexer, the hash of its block 1, or undefined when it cannot be
 * read (no block 1 yet, or no indexer). Best effort by design: an unreachable indexer blocks
 * nothing here, the sync itself retries it.
 */
export async function readChainIdentity(indexerUrl: string): Promise<string | undefined> {
  try {
    const block = await new IndexerClient(indexerUrl).getBlock({height: CHAIN_IDENTITY_HEIGHT});
    return block?.hash || undefined;
  } catch {
    return undefined;
  }
}

/** Pure, and separate from the store on purpose: the interesting behaviour is the verdict. */
export function cacheChainVerdict(stored: string | null, live: string | undefined): CacheChainVerdict {
  if (live === undefined) return {kind: 'unknown'};
  if (stored === null || stored === '') return {kind: 'stamped', current: live};
  if (stored === live) return {kind: 'kept', current: live};
  return {kind: 'replaced', previous: stored, current: live};
}

export interface ReconcileCacheChainOptions {
  readonly store: SyncStateStore;
  readonly walletName: string;
  readonly networkId: string;
  /** The live chain's identity, or undefined when the indexer could not be asked. */
  readonly live: string | undefined;
  /** Drops everything the old chain left — the caller's, since what that is depends on the host. Runs before the stamp moves. */
  readonly evict: (verdict: CacheChainVerdict & {kind: 'replaced'}) => Promise<void>;
}

/**
 * Compares the stored chain with the live one and acts on it: a replaced chain has its cache
 * evicted and the stamp moved, a cache without a stamp gets one, and nothing else changes. A
 * failure inside `evict` leaves the old stamp in place, so the next start evicts again rather
 * than trusting a half-cleared cache.
 */
export async function reconcileCacheChain(options: ReconcileCacheChainOptions): Promise<CacheChainVerdict> {
  const {store, walletName, networkId, live, evict} = options;
  const key = chainIdentityKey(networkId, walletName);
  const verdict = cacheChainVerdict(await store.get(key), live);
  if (verdict.kind === 'replaced') await evict(verdict);
  if (verdict.kind === 'replaced' || verdict.kind === 'stamped') await store.put(key, verdict.current);
  return verdict;
}

/** The first characters of a hash, enough to tell two chains apart in a log line. */
export const shortHash = (hash: string): string => `${hash.slice(0, 8)}…`;

/**
 * The sync line for a verdict: every start says what the check decided, so a failed run is
 * diagnosed from the sync log alone rather than from the absence of a line.
 */
export function describeChainVerdict(verdict: CacheChainVerdict, indexerUrl: string): string {
  switch (verdict.kind) {
    case 'kept':
      return `The chain at ${indexerUrl} is the one the cached state was synced on (block 1 ${shortHash(verdict.current)})`;
    case 'stamped':
      return `The chain at ${indexerUrl} is recorded beside the cached state (block 1 ${shortHash(verdict.current)}), which is taken to be its`;
    case 'replaced':
      return `The chain at ${indexerUrl} restarted from genesis (block 1 ${shortHash(verdict.previous)} → ${shortHash(verdict.current)}): cached state discarded, syncing from the start`;
    case 'unknown':
      return `The chain at ${indexerUrl} could not be asked which chain it is: cached state kept`;
  }
}
