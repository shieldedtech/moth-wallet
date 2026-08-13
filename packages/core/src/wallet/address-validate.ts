// WASM-free bech32m address validation for UI input paths (send recipient,
// address book). Reuses the SDK's real Midnight decoder — pure JS over
// @scure/base bech32m — so a mistyped address is caught at entry (bad
// checksum / wrong prefix) instead of failing deep in transaction building.
//
// This module deliberately imports ONLY `@midnightntwrk/wallet-sdk/address-format`
// (no ledger), so it stays safe to pull into UI pages that must not load the
// ledger WASM. The authoritative decode still happens in core at tx /
// registration build time; this is an early, cheap pre-check.

import {MidnightBech32m} from '@midnightntwrk/wallet-sdk/address-format';

/**
 * True when `address` is a well-formed Midnight bech32m string with a valid
 * checksum and the expected `mn` prefix. Never throws — returns false on any
 * malformed input.
 */
export function isValidBech32mAddress(address: string): boolean {
  const v = address.trim();
  if (!v) return false;
  try {
    MidnightBech32m.parse(v);
    return true;
  } catch {
    return false;
  }
}
