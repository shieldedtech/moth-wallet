// What the wallet knew about a transaction when it submitted it, persisted next
// to the sync state. The SDK's history says whether a submission is pending,
// applied or rejected, but its own entry for one carries only a hash; this
// record supplies the recipient and amount the row shows, and keeps the
// recipient visible after the transaction lands (a chain entry alone may not
// reveal the counterparty). Stored per wallet + network in the same store as
// the serialized sync state, so it survives session restarts alongside it.
//
// WASM-free: type-only imports plus the pure activity helpers.

import { sortActivity, type ActivityEntry } from '@shieldedtech/moth-wallet/sync/activity';
import type { SyncStateStore } from '@shieldedtech/moth-wallet/sync/sync-store';

export interface SubmittedTx {
  /** The submitted transaction's hash, or the facade's logical identifier for it. */
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

// Each write is a read followed by a put, so two of them interleaving would
// drop one another's change. They run one at a time per key.
const writes = new Map<string, Promise<void>>();

function updateSubmissions(
  store: SyncStateStore,
  networkId: string,
  walletName: string,
  update: (existing: SubmittedTx[]) => SubmittedTx[],
): Promise<void> {
  const key = submissionsKey(networkId, walletName);
  const run = (writes.get(key) ?? Promise.resolve()).then(async () => {
    await saveSubmissions(store, networkId, walletName, update(await loadSubmissions(store, networkId, walletName)));
  });
  const settled = run.catch(() => {});
  writes.set(key, settled);
  void settled.then(() => {
    if (writes.get(key) === settled) writes.delete(key);
  });
  return run;
}

export function recordSubmission(
  store: SyncStateStore,
  networkId: string,
  walletName: string,
  tx: SubmittedTx,
): Promise<void> {
  return updateSubmissions(store, networkId, walletName, (existing) => [
    ...existing.filter((s) => s.hash !== tx.hash),
    tx,
  ]);
}

/** Drop the records for `hashes`: stale ones, or one whose transaction was never sent. */
export function forgetSubmissions(
  store: SyncStateStore,
  networkId: string,
  walletName: string,
  hashes: readonly string[],
): Promise<void> {
  return updateSubmissions(store, networkId, walletName, (existing) =>
    existing.filter((s) => !hashes.includes(s.hash)),
  );
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
