// Shielded coins as a caller outside the wallet sees them: one row per coin, with
// the fields a Compact circuit takes as a QualifiedShieldedCoinInfo. A DApp cannot
// get these elsewhere: the connector API has no coin enumeration, and the indexer's
// Zswap state is filtered to a contract, so it yields no global Merkle index.

import type {WalletCoinDetails} from '../sync/wallet-sync.js';

export interface ShieldedCoinRow {
  type: string;
  value: bigint;
  /** Null only when the SDK did not report one. */
  nonce: string | null;
  /** Null for a pending coin: it is not in the commitment tree, so it cannot be spent yet. */
  mt_index: bigint | null;
  commitment: string | null;
  status: 'available' | 'pending';
}

/** Spendable coins first, then incoming ones. Field names follow QualifiedShieldedCoinInfo. */
export function shieldedCoinRows(coins: Pick<WalletCoinDetails, 'shielded'>): ShieldedCoinRow[] {
  return [
    ...coins.shielded.available.map((c) => ({
      type: c.type,
      value: c.value,
      nonce: c.nonce ?? null,
      mt_index: c.mtIndex ?? null,
      commitment: c.commitment ?? null,
      status: 'available' as const,
    })),
    ...coins.shielded.pending.map((c) => ({
      type: c.type,
      value: c.value,
      nonce: c.nonce ?? null,
      mt_index: null,
      commitment: c.commitment ?? null,
      status: 'pending' as const,
    })),
  ];
}
