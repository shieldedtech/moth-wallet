// Maps wallet balances onto the SyncStatus view model. Type-only wallet
// import, so the moth/sync-status.tsx view component stays SDK-free.

import type { WalletBalances } from '@shieldedtech/moth-browser';
import type { SyncStatusView } from '../../components/moth/sync-status';

export function syncStatusView(balances: WalletBalances): SyncStatusView {
  const percent = (applied: number, total: number, roleSynced: boolean) =>
    roleSynced ? 100 : total > 0 ? Math.min(100, Math.round((applied / total) * 100)) : 0;
  const sub = balances.subProgress;
  const progress = balances.syncProgress;
  return {
    shielded: percent(sub.shielded.applied, sub.shielded.total, progress.shieldedSynced),
    unshielded: percent(sub.unshielded.applied, sub.unshielded.total, progress.unshieldedSynced),
    dust: percent(sub.dust.applied, sub.dust.total, progress.dustSynced),
    etaSeconds: progress.etaSeconds,
  };
}

/**
 * The dust sub-wallet's raw progress fraction, or undefined when there is
 * nothing to measure.
 *
 * Passed to useSyncRegressionGrace so a rebuild's large drop is reported at
 * once rather than smoothed over. Defined here rather than at each call site
 * because Home and DustDetail both need it and had drifted into two copies.
 */
export function dustFraction(balances: WalletBalances | null): number | undefined {
  const dust = balances?.subProgress.dust;
  return dust && dust.total > 0 ? dust.applied / dust.total : undefined;
}
