// Maps wallet balances onto the SyncStatus view model. Type-only wallet
// import, so the moth/sync-status.tsx view component stays SDK-free.

import type { WalletBalances } from '@shieldedtech/moth-browser';
import type { SyncStatusView } from '../../components/moth/sync-status';

export function syncStatusView(balances: WalletBalances): SyncStatusView {
  // Applying the reported total does not guarantee SDK completion yet.
  // Reserve 100% for the completion flag so the header agrees with the DUST mask.
  const percent = (applied: number, total: number, roleSynced: boolean) =>
    roleSynced ? 100 : total > 0 ? Math.min(99, Math.floor((applied / total) * 100)) : 0;
  const sub = balances.subProgress;
  const progress = balances.syncProgress;
  return {
    shielded: percent(sub.shielded.applied, sub.shielded.total, progress.shieldedSynced),
    unshielded: percent(sub.unshielded.applied, sub.unshielded.total, progress.unshieldedSynced),
    dust: percent(sub.dust.applied, sub.dust.total, progress.dustSynced),
  };
}
