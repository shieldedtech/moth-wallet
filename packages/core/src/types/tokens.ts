// Pure NIGHT token helpers: a token-id constant and a bigint formatter, both
// dependency-free. This module MUST stay WASM-free — it's imported by the
// extension UI pages, which must not pull in the ledger WASM. Do not add
// imports from the wallet SDK / ledger here.

export const NIGHT_TOKEN_ID = '0'.repeat(64);

export function formatNight(raw: bigint): string {
  const major = raw / 1_000_000n;
  const minor = raw % 1_000_000n;
  return `${major}.${String(minor).padStart(6, '0')}`;
}
