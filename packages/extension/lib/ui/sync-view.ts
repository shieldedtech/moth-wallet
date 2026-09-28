// Maps wallet balances onto the SyncStatus view model. Type-only wallet
// import, so the moth/sync-status.tsx view component stays SDK-free.

import { subProgressPercent } from '@shieldedtech/moth-browser';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import type { SyncStatusView } from '../../components/moth/sync-status';

// Share core's percentage rather than rounding again here: the local copy
// rounded 99.96% up to 100, and the header badge averages these three rows.
export function syncStatusView(balances: WalletBalances): SyncStatusView {
  const sub = balances.subProgress;
  const progress = balances.syncProgress;
  return {
    shielded: subProgressPercent(sub.shielded, progress.shieldedSynced),
    unshielded: subProgressPercent(sub.unshielded, progress.unshieldedSynced),
    dust: subProgressPercent(sub.dust, progress.dustSynced),
  };
}
