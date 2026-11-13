// Locally-submitted transactions, persisted next to the sync state. A
// submission reaches on-chain history only once the indexer reports it applied,
// and one that moves none of the wallet's coins never does. Recording what we
// submitted bridges that gap: the activity feed shows it as pending, calls it
// failed once the node or the SDK's pending tracker rules it out, and keeps the
// recipient visible after it lands (a chain entry alone may not reveal the
// counterparty). Stored per wallet + network in the same store as the
// serialized sync state, so it survives session restarts alongside it.
//
// WASM-free: type-only imports plus the pure activity helpers.

import { sortActivity, type ActivityEntry } from '@shieldedtech/moth-wallet/sync/activity';
import type { SyncStateStore } from '@shieldedtech/moth-wallet/sync/sync-store';

export interface SubmissionFailure {
  /** Epoch ms the verdict was reached. */
  at: number;
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
  /** Epoch ms after which the ledger rejects the transaction, when known. */
  expiresAt?: number;
  /** The node reported the transaction in a finalized block. */
  confirmed?: boolean;
  /** Set once the transaction is known not to have gone through. */
  failure?: SubmissionFailure;
}

/** The slice of a ledger transaction read for its deadline, structural so this
 *  module stays WASM-free. */
export interface TransactionWithIntents {
  intents?: ReadonlyMap<number, { ttl: Date }>;
}

/**
 * When the ledger stops accepting `tx`: its earliest intent TTL, since every
 * intent has to be in date for the transaction to apply. Undefined for a
 * transaction without intents.
 */
export function transactionDeadline(tx: TransactionWithIntents): number | undefined {
  let earliest: number | undefined;
  for (const intent of tx.intents?.values() ?? []) {
    const ttl = intent.ttl.getTime();
    if (Number.isFinite(ttl) && (earliest === undefined || ttl < earliest)) earliest = ttl;
  }
  return earliest;
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

/** How long a submission with no known deadline stays pending before the feed
 *  calls it failed. Covers the hour the wallet and midnight-js give their own
 *  transactions; a chain entry that turns up later still wins. */
export const SUBMISSION_PENDING_TTL_MS = 2 * 60 * 60 * 1000;

/** Slack past a known deadline, for clock skew and a block the indexer has not
 *  delivered yet. */
export const SUBMISSION_DEADLINE_MARGIN_MS = 10 * 60 * 1000;

/** Whether an unreported submission can no longer land. The network's TTL
 *  ceiling is a ledger parameter (two weeks on mainnet), so a recorded
 *  deadline decides and the fixed window is only the fallback. */
function isStale(tx: SubmittedTx, now: number): boolean {
  return tx.expiresAt !== undefined
    ? now >= tx.expiresAt + SUBMISSION_DEADLINE_MARGIN_MS
    : now - tx.submittedAt >= SUBMISSION_PENDING_TTL_MS;
}

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

// Writers run one at a time per key. A verdict arrives off the sync stream
// while an operation records its own submission, and two interleaved
// load-then-save passes would drop whichever saved first.
const writes = new Map<string, Promise<unknown>>();

function updateSubmissions<T>(
  store: SyncStateStore,
  networkId: string,
  walletName: string,
  update: (existing: SubmittedTx[]) => { next?: SubmittedTx[]; result: T },
): Promise<T> {
  const key = submissionsKey(networkId, walletName);
  const run = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const { next, result } = update(await loadSubmissions(store, networkId, walletName));
    if (next) await saveSubmissions(store, networkId, walletName, next);
    return result;
  });
  writes.set(key, run);
  const settle = () => {
    if (writes.get(key) === run) writes.delete(key);
  };
  run.then(settle, settle);
  return run;
}

export function recordSubmission(
  store: SyncStateStore,
  networkId: string,
  walletName: string,
  tx: SubmittedTx,
): Promise<void> {
  return updateSubmissions(store, networkId, walletName, (existing) => ({
    next: [...existing.filter((s) => s.hash !== tx.hash), tx],
    result: undefined,
  }));
}

/**
 * Mark the submission known by any of `ids` (its hash, its transaction hash or
 * a logical identifier) as failed. The first verdict sticks. Returns whether a
 * submission matched.
 */
export function recordSubmissionFailure(
  store: SyncStateStore,
  networkId: string,
  walletName: string,
  ids: readonly string[],
  failure: SubmissionFailure,
): Promise<boolean> {
  const wanted = new Set(ids);
  return updateSubmissions(store, networkId, walletName, (existing) => {
    let matched = false;
    const next = existing.map((tx) => {
      const known = wanted.has(tx.hash) || (tx.transactionHash !== undefined && wanted.has(tx.transactionHash));
      if (!known) return tx;
      matched = true;
      return tx.failure ? tx : { ...tx, failure };
    });
    return matched ? { next, result: true } : { result: false };
  });
}

/** A submission history has not reported, as a failed row, a pending one, or a
 *  settled one once the node has confirmed it. */
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
    pending: !failed && !tx.confirmed,
    outputs: tx.outputs,
  };
}

/**
 * Merge on-chain activity with local submissions: enrich applied entries with
 * the recipient and token movement we recorded at send time, and surface the
 * rest as pending rows, or as failed rows once a verdict is in. `synced` says
 * whether history has reached the chain tip; until it has, a submission's age
 * proves nothing, so an old one stays pending rather than being called failed.
 * Nor does age count against a confirmed submission: one that moved none of
 * the wallet's coins has no history entry to wait for.
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
      const stale = synced && !tx.confirmed && isStale(tx, now);
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
