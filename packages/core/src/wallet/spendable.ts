// What a wallet can actually spend, as opposed to what it holds.
//
// The displayed balance counts pending coins on purpose: a send or a DUST
// registration reserves its own NIGHT UTxOs while the transaction is in flight,
// and dropping them from the total would flash the balance to zero mid-operation
// (see the note at wallet-sync.ts:1004). But the SDK spends from availableUtxos
// alone, so the displayed figure is not the spendable one — and when a reserved
// transfer never settles, a wallet reports its full balance and can spend none
// of it.
//
// Nothing here computes anything new. `WalletBalances.coins` already carries the
// split; this only adds it up, so both numbers can be shown side by side rather
// than one of them being discovered through a failed transfer.

import type {WalletCoinDetails} from '../sync/wallet-sync.js';

export interface SpendableSplit {
  /** Sum of available (immediately spendable) coins of this token. */
  readonly available: bigint;
  /** Sum reserved by transactions in flight — counted in the balance, not spendable. */
  readonly reserved: bigint;
  /** available + reserved: the figure `balance` has always shown. */
  readonly total: bigint;
}

/** Unshielded split for one token id. */
export function unshieldedSplit(coins: WalletCoinDetails, tokenId: string): SpendableSplit {
  const sum = (list: ReadonlyArray<{value: bigint; type: string}>) =>
    list.reduce((acc, c) => (c.type === tokenId ? acc + c.value : acc), 0n);
  const available = sum(coins.unshielded.available);
  const reserved = sum(coins.unshielded.pending);
  return {available, reserved, total: available + reserved};
}

/**
 * A sentence for the case where a wallet holds enough but can spend too little.
 *
 * Returns null when the shortfall is not a reservation problem, so callers can
 * fall through to the plain message rather than explaining something untrue.
 */
export function describeReservation(
  split: SpendableSplit,
  wanted: bigint,
  format: (raw: bigint) => string,
): string | null {
  if (split.reserved === 0n) return null;
  if (split.available >= wanted) return null;
  return (
    `${format(split.total)} held, ${format(split.available)} available — ` +
    `${format(split.reserved)} is reserved by a transaction still in flight. ` +
    'A transfer can only spend the available part. Reservations clear when that ' +
    'transaction settles; if it never will, clearing the wallet\'s sync cache ' +
    'drops them and re-reads the chain.'
  );
}
