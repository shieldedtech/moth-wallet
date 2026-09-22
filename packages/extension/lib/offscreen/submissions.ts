// Locally-submitted transactions, persisted next to the sync state. A
// submission reaches on-chain history only once the indexer reports it applied;
// recording what we submitted bridges that gap: the activity feed shows it as
// pending immediately, calls it failed once the node or the SDK's pending
// tracker rules it out, and keeps the recipient visible after it lands (a chain
// entry alone may not reveal the counterparty). Stored per wallet + network in
// the same store as the serialized sync state, so it survives session restarts
// alongside it.
//
// WASM-free: type-only imports plus the pure activity helpers.

import { sortActivity, type ActivityEntry } from '@shieldedtech/moth-wallet/sync/activity';
import type { SyncStateStore } from '@shieldedtech/moth-wallet/sync/sync-store';

export interface SubmissionFailure {
  /** Epoch ms the verdict was reached. */
  at: number;
  /** The node's rejection, when the transaction never entered the pool. */
  message?: string;
}

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
  /** Set once the transaction is known not to have gone through. */
  failure?: SubmissionFailure;
}

/** What the wallet learned about a connector transaction before the dApp asked
 *  it to submit: the deficits it covered when balancing, or the transfer it
 *  built. Fees are never part of it. */
export interface PreparedSubmission {
  spends: Array<{ kind: 'shielded' | 'unshielded' | 'dust'; tokenId: string; amount: string }>;
  /** Set when the wallet built the transfer itself (connector makeTransfer). */
  transfer?: { to?: string; outputs: number };
}

/**
 * The record for a connector-submitted transaction. A lone non-DUST spend is
 * the amount the row shows; a mixed spend has no single figure, and a DUST-only
 * transaction (a contract call paying just its fee) is a plain send until the
 * chain entry says what it was. Without preparation only the hash is known.
 */
export function connectorSubmission(hash: string, prepared: PreparedSubmission | undefined, now: number): SubmittedTx {
  const base: SubmittedTx = { hash, transactionHash: hash, submittedAt: now, kind: 'send' };
  if (!prepared) return base;
  const tokens = prepared.spends.filter(
    (spend): spend is typeof spend & { kind: 'shielded' | 'unshielded' } => spend.kind !== 'dust',
  );
  const single = tokens.length === 1 ? tokens[0] : undefined;
  return {
    ...base,
    to: prepared.transfer?.to,
    outputs: prepared.transfer?.outputs,
    ...(single ? { tokenType: single.tokenId, tokenKind: single.kind, amount: single.amount } : {}),
  };
}

/** Newest submissions kept per wallet + network. */
export const SUBMISSIONS_MAX = 100;

/** How long an unconfirmed submission stays pending before the feed calls it
 *  failed. The ledger accepts no intent deadline beyond an hour, so a
 *  transaction unseen this long can no longer be included; a chain entry that
 *  turns up later still wins. */
export const SUBMISSION_PENDING_TTL_MS = 2 * 60 * 60 * 1000;

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

/**
 * Mark the submission known by any of `ids` (its hash, its transaction hash or
 * a logical identifier) as failed. The first verdict sticks. Returns whether a
 * submission matched.
 */
export async function recordSubmissionFailure(
  store: SyncStateStore,
  networkId: string,
  walletName: string,
  ids: readonly string[],
  failure: SubmissionFailure,
): Promise<boolean> {
  const wanted = new Set(ids);
  const existing = await loadSubmissions(store, networkId, walletName);
  let matched = false;
  const next = existing.map((tx) => {
    const known = wanted.has(tx.hash) || (tx.transactionHash !== undefined && wanted.has(tx.transactionHash));
    if (!known) return tx;
    matched = true;
    return tx.failure ? tx : { ...tx, failure };
  });
  if (matched) await saveSubmissions(store, networkId, walletName, next);
  return matched;
}

/** A submission the chain has not reported, as a pending or a failed row. */
function toLocalEntry(tx: SubmittedTx, failed: boolean): ActivityEntry {
  const hasAmount = tx.amount !== undefined && tx.tokenType !== undefined;
  return {
    hash: tx.hash,
    kind: tx.kind === 'dust' ? 'dust' : 'sent',
    status: failed ? 'FAILURE' : 'SUCCESS',
    timestamp: new Date(tx.submittedAt),
    deltas: hasAmount
      ? [{ tokenType: tx.tokenType!, kind: tx.tokenKind ?? 'unshielded', amount: -BigInt(tx.amount!) }]
      : [],
    dustDelta: 0n,
    counterparty: tx.to ?? null,
    fees: null,
    pending: !failed,
    outputs: tx.outputs,
  };
}

/**
 * Merge on-chain activity with local submissions: enrich applied entries with
 * the recipient and token movement we recorded at send time, and surface the
 * rest as pending rows, or as failed rows once a verdict is in. `synced` says
 * whether history has reached the chain tip; until it has, a submission's age
 * proves nothing, so an old one stays pending rather than being called failed.
 */
export function mergeSubmissions(
  chain: ActivityEntry[],
  submissions: SubmittedTx[],
  now: number,
  synced = true,
): ActivityEntry[] {
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
    } else {
      const stale = synced && now - tx.submittedAt >= SUBMISSION_PENDING_TTL_MS;
      entries.push(toLocalEntry(tx, tx.failure !== undefined || stale));
    }
  }

  return sortActivity(entries);
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
