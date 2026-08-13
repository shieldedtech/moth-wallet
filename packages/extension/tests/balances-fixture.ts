// Shared WalletBalances fixture for UI tests. Dust amounts and sync state are
// configurable; everything else defaults to a fully synced, empty wallet.
// Imports from the wallet packages stay type-only / WASM-free so vitest never
// loads the ledger WASM.

import type { WalletBalances } from '@shieldedtech/moth-browser';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';

export function makeBalances({
  dust = 0n,
  limit = 0n,
  night = 0n,
  shielded = {},
  unshielded = {},
  registered = false,
  registeredNight,
  generatingNight,
  newestRegisteredAt = null,
  dustSynced = true,
  fillTime = new Date(0),
}: {
  dust?: bigint;
  limit?: bigint;
  night?: bigint;
  shielded?: Record<string, bigint>;
  /** Extra unshielded tokens, merged in beside NIGHT. */
  unshielded?: Record<string, bigint>;
  registered?: boolean;
  /** NIGHT (raw STAR) registered for DUST generation. Defaults to the whole
   *  balance when `registered`, so existing fully-registered cases stay valid. */
  registeredNight?: bigint;
  /** NIGHT (raw STAR) with live generation records (designated). Defaults like
   *  registeredNight. */
  generatingNight?: bigint;
  /** Creation time of the newest registered NIGHT UTXO. */
  newestRegisteredAt?: Date | null;
  dustSynced?: boolean;
  fillTime?: Date;
} = {}): WalletBalances {
  return {
    shielded,
    unshielded: { [NIGHT_TOKEN_ID]: night, ...unshielded },
    dust,
    dustGeneration: {
      balance: dust,
      designated: generatingNight ?? (registered ? night : 0n),
      ratePerDay: 0n,
      limit,
      fillTime,
      numUtxos: limit > 0n ? 1 : 0,
      registered,
      registeredNight: registeredNight ?? (registered ? night : 0n),
      newestRegisteredAt,
    },
    syncProgress: {
      percentage: dustSynced ? 1 : 0.4,
      slowest: null,
      etaSeconds: dustSynced ? 0 : null,
      shieldedSynced: true,
      unshieldedSynced: true,
      dustSynced,
    },
    synced: dustSynced,
    coins: {
      shielded: { available: [], pending: [] },
      unshielded: { available: [], pending: [] },
      dust: { available: [], pending: [] },
    },
    subProgress: {
      shielded: { applied: 10, total: 10 },
      unshielded: { applied: 10, total: 10 },
      dust: { applied: dustSynced ? 10 : 4, total: 10 },
    },
  };
}
