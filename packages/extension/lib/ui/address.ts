// Midnight address shape detection, shared by the send flow, DUST designation
// and the address book. The prefix checks are cheap WASM-free sanity checks;
// `isValidAddress` additionally verifies the bech32m checksum via core's
// WASM-free validator, so a mistyped address is rejected at entry rather than
// failing later at tx-build time. The authoritative parse still happens in core
// when a transaction or registration is built.

import { isValidBech32mAddress } from '@shieldedtech/moth-wallet/wallet/address-validate';

export type AddressKind = 'shielded' | 'unshielded' | 'dust';

// Order matters: shielded's "mn_shield-addr" must be tested before unshielded's
// "mn_addr" (the latter is not a prefix of the former, but keep them explicit).
const PATTERNS: Record<AddressKind, RegExp> = {
  shielded: /^mn_shield-addr[a-z0-9_]*1[a-z0-9]{20,}$/i,
  unshielded: /^mn_addr[a-z0-9_]*1[a-z0-9]{20,}$/i,
  dust: /^mn_dust[a-z0-9_]*1[a-z0-9]{20,}$/i,
};

/** True when `value` looks like an address of the given kind (prefix/shape
 *  only — no checksum). Use for classification; use `isValidAddress` to
 *  accept user input. */
export function isAddressOfKind(kind: AddressKind, value: string): boolean {
  return PATTERNS[kind].test(value.trim());
}

/** True when `value` is the given kind AND its bech32m checksum is valid.
 *  This is the gate for accepting user-entered addresses (send recipient,
 *  address book) so a typo is caught at entry, not at tx-build time. */
export function isValidAddress(kind: AddressKind, value: string): boolean {
  const v = value.trim();
  return isAddressOfKind(kind, v) && isValidBech32mAddress(v);
}

/** The kind an address looks like, or null if it matches none. */
export function addressKind(value: string): AddressKind | null {
  const trimmed = value.trim();
  // shielded before unshielded — "mn_shield-addr…" also starts with "mn_"
  // but must never be classified as unshielded.
  if (PATTERNS.shielded.test(trimmed)) return 'shielded';
  if (PATTERNS.unshielded.test(trimmed)) return 'unshielded';
  if (PATTERNS.dust.test(trimmed)) return 'dust';
  return null;
}

/** Placeholder hint shown in a recipient/receiver field for the given kind. */
export function addressPlaceholder(kind: AddressKind): string {
  return kind === 'shielded' ? 'mn_shield-addr…' : kind === 'dust' ? 'mn_dust…' : 'mn_addr…';
}

/** Human label for a kind, used in the address book and pickers. */
export function addressKindLabel(kind: AddressKind): string {
  return kind === 'shielded' ? 'Shielded' : kind === 'dust' ? 'DUST' : 'Unshielded';
}
