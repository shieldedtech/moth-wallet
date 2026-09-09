// When to suggest registering NIGHT for DUST generation, unprompted.
//
// Registration binds the NIGHT signing key (DustRegistration), so NIGHT
// received AFTER a first registration auto-registers — see DustDetail.tsx.
// The gap this closes is the FIRST registration: a wallet that has never
// registered gets no nudge otherwise, and the register flow's own warning
// (dust-register-timing.ts) only fires once the user is already in that
// flow. Registering promptly, at the moment NIGHT is first observed, has
// never been linked to the devnet dust-ledger defect docs/bugs-found.md
// reports (#15); waiting has.

import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import type { WalletBalances } from '@shieldedtech/moth-browser';

/**
 * True the moment a wallet that has never registered any NIGHT shows
 * unregistered NIGHT, fully synced. Not true again for the same wallet once
 * it has registered — deregistering is a deliberate choice this should not
 * second-guess.
 */
export function hasUnregisteredNightToNudge(balances: WalletBalances | null): boolean {
  if (!balances || !balances.syncProgress.dustSynced) return false;
  const night = balances.unshielded[NIGHT_TOKEN_ID] ?? 0n;
  const registered = balances.dustGeneration?.registered === true;
  return night > 0n && !registered;
}
