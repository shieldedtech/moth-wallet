// Folding booked (pending) unshielded inputs into the displayed balance.
//
// WASM-free on purpose, so the arithmetic is unit-testable without loading the
// ledger — the same split as progress.ts and preseed-parts.ts.
//
// Why fold at all: a send or DUST registration reserves its own NIGHT UTXOs
// while the transaction is in flight. The SDK moves those from `availableUtxos`
// to `pendingUtxos`, and `UnshieldedWallet.balances` reports the available map
// only — so without the fold the balance flashes down to zero mid-registration
// and back up on apply.
//
// Why it needs care: the fold assumes the two maps are disjoint, which is what
// the SDK's `spend()` maintains (remove from available, add to pending). That
// assumption breaks. A booking whose transaction never reaches the chain is
// never released, and a later sync re-adds the UTXO to `availableUtxos` without
// checking whether it is still booked, leaving the same UTXO in both maps. The
// balance map then already counts it, the fold counts it again, and the wallet
// displays exactly twice its real balance — permanently, since the state is
// persisted. See docs/upstream/wallet-sdk-unshielded-booking-never-released.md.

/** A UTXO reduced to what the fold needs. */
export interface BookableUtxo {
  /** `intentHash:outputNo` — the SDK's own identity for a UTXO. */
  readonly id: string;
  readonly type: string;
  readonly value: bigint;
}

/** The SDK's identity for a UTXO, matching its internal `UtxoHash`. */
export function utxoId(utxo: {intentHash?: unknown; outputNo?: unknown} | undefined): string {
  return `${String(utxo?.intentHash ?? '?')}:${String(utxo?.outputNo ?? '?')}`;
}

export interface FoldResult {
  /** Displayed balance per token type: available, plus genuinely booked inputs. */
  readonly balances: Record<string, bigint>;
  /**
   * Ids present in BOTH lists. Each is a coin the SDK is reporting as spendable
   * and booked at once, which is impossible — the booking is stale. They are
   * counted once (as available) and reported here so the caller can say so.
   */
  readonly duplicated: ReadonlyArray<string>;
}

/**
 * Add booked inputs to the available balance, skipping any UTXO that is also
 * listed as available.
 *
 * A duplicate is counted ONCE, as available, because that is the truth on chain:
 * the transaction that booked it never landed, so the coin is unspent. Treating
 * it as booked instead would be the other failure — a balance that is correct
 * but a coin the wallet refuses to spend.
 */
export function foldBookedInputs(
  available: ReadonlyArray<BookableUtxo>,
  pending: ReadonlyArray<BookableUtxo>,
  /** The SDK's balance map, which covers the available list only. */
  availableBalances: Record<string, bigint>,
): FoldResult {
  const balances: Record<string, bigint> = {...availableBalances};
  const availableIds = new Set(available.map((u) => u.id));
  const duplicated: string[] = [];

  for (const coin of pending) {
    if (availableIds.has(coin.id)) {
      duplicated.push(coin.id);
      continue;
    }
    balances[coin.type] = (balances[coin.type] ?? 0n) + coin.value;
  }

  return {balances, duplicated};
}
