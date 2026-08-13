// Locally-submitted transactions, persisted next to the sync state. A
// submission reaches on-chain history only once the indexer reports it applied;
// recording what we submitted bridges that gap: the activity feed shows it as
// pending immediately, and keeps the recipient visible after it lands (a chain
// entry alone may not reveal the counterparty). Stored per wallet + network in
// the same store as the serialized sync state, so it survives session restarts
// alongside it.
//
// WASM-free: type-only imports plus the pure activity helpers.

import { sortActivity, type ActivityEntry } from '@shieldedtech/moth-wallet/sync/activity';
import type { SyncStateStore } from '@shieldedtech/moth-wallet/sync/sync-store';

export interface SubmittedTx {
  /** Stable logical identifier returned by the wallet facade. */
  hash: string;
  /** Hash of the finalized transaction submitted to the node. */
  transactionHash?: string;
  /** Epoch ms at submission. */
  submittedAt: number;
  kind: 'send' | 'dust';
  to?: string;
  tokenType?: string;
  tokenKind?: 'shielded' | 'unshielded';
  /** Base units as a decimal string. */
  amount?: string;
  /** Number of transfers in a (possibly batched) send. */
  outputs?: number;
}

/** Newest submissions kept per wallet + network. */
export const SUBMISSIONS_MAX = 100;

/** A submission unseen on chain for this long is stale (rejected or lost) —
 *  stop showing it as pending and drop it from storage. */
export const SUBMISSION_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export function submissionsKey(networkId: string, walletName: string): string {
  return `activity/${networkId}/${walletName}/submissions.json`;
}

export async function loadSubmissions(
  store: SyncStateStore,
  networkId: string,
  walletName: string,
): Promise<SubmittedTx[]> {
  try {
    const raw = await store.get(submissionsKey(networkId, walletName));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SubmittedTx[]) : [];
  } catch {
    return [];
  }
}

export async function saveSubmissions(
  store: SyncStateStore,
  networkId: string,
  walletName: string,
  submissions: SubmittedTx[],
): Promise<void> {
  await store.put(submissionsKey(networkId, walletName), JSON.stringify(submissions.slice(-SUBMISSIONS_MAX)));
}

export async function recordSubmission(
  store: SyncStateStore,
  networkId: string,
  walletName: string,
  tx: SubmittedTx,
): Promise<void> {
  const existing = await loadSubmissions(store, networkId, walletName);
  await saveSubmissions(store, networkId, walletName, [
    ...existing.filter((s) => s.hash !== tx.hash),
    tx,
  ]);
}

/** Turn a not-yet-applied submission into a provisional activity entry. */
function toPendingEntry(tx: SubmittedTx): ActivityEntry {
  const hasAmount = tx.amount !== undefined && tx.tokenType !== undefined;
  return {
    hash: tx.hash,
    kind: tx.kind === 'dust' ? 'dust' : 'sent',
    status: 'SUCCESS',
    timestamp: new Date(tx.submittedAt),
    deltas: hasAmount
      ? [{ tokenType: tx.tokenType!, kind: tx.tokenKind ?? 'unshielded', amount: -BigInt(tx.amount!) }]
      : [],
    dustDelta: 0n,
    counterparty: tx.to ?? null,
    fees: null,
    pending: true,
    outputs: tx.outputs,
  };
}

export interface MergedActivity {
  entries: ActivityEntry[];
  /** Hashes of stale submissions the caller should drop from storage. */
  prune: string[];
}

/**
 * Merge on-chain activity with local submissions: enrich applied entries with
 * the recipient and token movement we recorded at send time, surface fresh
 * unapplied submissions as pending rows, and flag stale ones for pruning.
 */
export function mergeSubmissions(
  chain: ActivityEntry[],
  submissions: SubmittedTx[],
  now: number,
): MergedActivity {
  // submitTransaction returns a stable logical identifier, whereas applied
  // history is keyed by the containing chain transaction's hash. A transaction
  // may be merged before it lands, so index both identities when history makes
  // the logical identifiers available.
  const byIdentity = new Map<string, ActivityEntry>();
  for (const entry of chain) {
    byIdentity.set(entry.hash, entry);
    for (const identifier of entry.identifiers ?? []) {
      byIdentity.set(identifier, entry);
    }
  }
  const entries = [...chain];
  const prune: string[] = [];

  for (const tx of submissions) {
    const applied = byIdentity.get(tx.hash)
      ?? (tx.transactionHash ? byIdentity.get(tx.transactionHash) : undefined);
    if (applied) {
      if (!applied.counterparty && tx.to) applied.counterparty = tx.to;
      // The SDK stores shielded and DUST history entries without their block
      // timestamps (only the unshielded wallet keeps them), and sortActivity
      // sinks timestamp-less entries below the whole feed. For our own
      // submissions the recorded submit time is a faithful stand-in.
      if (!applied.timestamp) applied.timestamp = new Date(tx.submittedAt);
      graftSendDelta(applied, tx);
    } else if (now - tx.submittedAt < SUBMISSION_PENDING_TTL_MS) {
      entries.push(toPendingEntry(tx));
    } else {
      prune.push(tx.hash);
    }
  }

  return { entries: sortActivity(entries), prune };
}

/**
 * A full-balance shielded send leaves the sender no change output, so the
 * indexer reports nothing to the sender's shielded wallet — the transfer's
 * only chain entry is the DUST fee spend. Deriving that alone yields a bare
 * fee row (kind 'dust', no token movement) and the transfer disappears from
 * "Sent". The submission remembers what was sent; graft it in whenever the
 * applied entry lacks that token's delta. Recomputed on every merge (never
 * persisted into chain data), so if the wallet later learns the real spend
 * the recorded delta yields to it.
 */
function graftSendDelta(applied: ActivityEntry, tx: SubmittedTx): void {
  if (tx.kind !== 'send' || tx.tokenType === undefined || tx.amount === undefined) return;
  if (applied.deltas.some((delta) => delta.tokenType === tx.tokenType)) return;
  applied.deltas = [
    ...applied.deltas,
    { tokenType: tx.tokenType, kind: tx.tokenKind ?? 'unshielded', amount: -BigInt(tx.amount) },
  ];
  if (applied.kind === 'dust') applied.kind = 'sent';
}
