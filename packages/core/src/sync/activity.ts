// Activity feed derivation: turns the SDK's stored transaction-history entries
// (WalletEntry — per-tx shielded/unshielded/dust sections) into display-ready
// entries with a direction, net per-token movements and, when the entry reveals
// it, the counterparty address.
//
// IMPORTANT: this module must stay WASM-free (type-only SDK imports) — UI
// bundles import it for the types and pure helpers.

import type {WalletEntry} from '@midnightntwrk/wallet-sdk/facade';

export type ActivityKind = 'sent' | 'received' | 'swap' | 'dust';
export type ActivityStatus = 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS';

/** Net movement of one token for the wallet; negative = left the wallet. */
export interface ActivityDelta {
  tokenType: string;
  kind: 'shielded' | 'unshielded';
  amount: bigint;
}

export interface ActivityEntry {
  hash: string;
  /** Stable logical identifiers for this transaction, when history exposes them. */
  identifiers?: string[];
  kind: ActivityKind;
  status: ActivityStatus;
  /** Block timestamp; null for older/partial records. */
  timestamp: Date | null;
  /** Net per-token movements, largest magnitude first. Excludes DUST. */
  deltas: ActivityDelta[];
  /** Net DUST movement (initial values of received minus spent DUST UTXOs). */
  dustDelta: bigint;
  /** The other side's unshielded address, when the entry reveals it. */
  counterparty: string | null;
  /** DUST paid in fees, when the indexer reported it. */
  fees: bigint | null;
  /** True for a locally-submitted transaction not yet seen on chain. */
  pending: boolean;
  /** Number of outgoing destination outputs the wallet can see — how many
   *  transfers a single (possibly batched) transaction carried. Counts
   *  external unshielded created UTxOs; shielded recipients are unknowable
   *  (their notes can't be decrypted), so a shielded-only batch reads 0. */
  outputs?: number;
}

function addDelta(
  deltas: Map<string, ActivityDelta>,
  kind: 'shielded' | 'unshielded',
  tokenType: string,
  amount: bigint,
): void {
  const key = `${kind}:${tokenType}`;
  const existing = deltas.get(key);
  if (existing) existing.amount += amount;
  else deltas.set(key, {tokenType, kind, amount});
}

/**
 * Derive one activity entry from a stored history entry.
 *
 * Unshielded UTXOs carry an owner address: the wallet's own movements are the
 * UTXOs it owns, and any foreign owner is the counterparty (recipient on a
 * created UTXO, sender on a spent one). Some indexers only report the wallet's
 * own UTXOs — then no foreign owner appears and the counterparty stays null.
 * If NO owner matches `ownAddress`, the address comparison itself is broken
 * (unexpected encoding); every UTXO is then counted as the wallet's own, which
 * matches the wallet-relevant-only reporting model, instead of derailing every
 * entry to zero movement. Shielded coins never carry owners: only the wallet
 * can decrypt its own notes, so they are all wallet movements by construction.
 */
export function deriveActivityEntry(entry: WalletEntry, ownAddress: string): ActivityEntry {
  const deltas = new Map<string, ActivityDelta>();
  let recipient: string | null = null;
  let sender: string | null = null;

  const created = entry.unshielded?.createdUtxos ?? [];
  const spent = entry.unshielded?.spentUtxos ?? [];
  const anyOwn = [...created, ...spent].some((utxo) => utxo.owner === ownAddress);
  const isOwn = (owner: string) => !anyOwn || owner === ownAddress;

  let outputs = 0;
  for (const utxo of created) {
    if (isOwn(utxo.owner)) addDelta(deltas, 'unshielded', utxo.tokenType, utxo.value);
    else {
      recipient ??= utxo.owner;
      outputs += 1; // each external created UTxO is one outgoing transfer
    }
  }
  for (const utxo of spent) {
    if (isOwn(utxo.owner)) addDelta(deltas, 'unshielded', utxo.tokenType, -utxo.value);
    else sender ??= utxo.owner;
  }

  for (const coin of entry.shielded?.receivedCoins ?? []) {
    addDelta(deltas, 'shielded', coin.type, coin.value);
  }
  for (const coin of entry.shielded?.spentCoins ?? []) {
    addDelta(deltas, 'shielded', coin.type, -coin.value);
  }

  let dustDelta = 0n;
  for (const utxo of entry.dust?.receivedUtxos ?? []) dustDelta += utxo.initialValue;
  for (const utxo of entry.dust?.spentUtxos ?? []) dustDelta -= utxo.initialValue;

  const net = [...deltas.values()].filter((delta) => delta.amount !== 0n);
  net.sort((a, b) => (abs(b.amount) > abs(a.amount) ? 1 : abs(b.amount) < abs(a.amount) ? -1 : 0));

  const hasNegative = net.some((delta) => delta.amount < 0n);
  const hasPositive = net.some((delta) => delta.amount > 0n);
  const kind: ActivityKind =
    hasNegative && hasPositive ? 'swap' : hasNegative ? 'sent' : hasPositive ? 'received' : 'dust';

  return {
    hash: entry.hash,
    identifiers: entry.identifiers ? [...entry.identifiers] : undefined,
    kind,
    status: entry.status,
    timestamp: entry.timestamp ?? null,
    deltas: net,
    dustDelta,
    counterparty: kind === 'sent' || kind === 'swap' ? recipient : kind === 'received' ? sender : null,
    fees: entry.fees ?? null,
    pending: false,
    outputs,
  };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Newest first; entries without a timestamp keep their relative order at the end. */
export function sortActivity<T extends {timestamp: Date | null}>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0));
}

export function deriveActivity(entries: readonly WalletEntry[], ownAddress: string): ActivityEntry[] {
  return sortActivity(entries.map((entry) => deriveActivityEntry(entry, ownAddress)));
}
