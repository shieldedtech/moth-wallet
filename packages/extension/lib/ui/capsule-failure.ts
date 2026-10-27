// The wallet's own failures of a site's transaction, in the user's words. WASM-free, like
// sync-view.ts, so the mapping is tested against the catalog without the runtime.
import type { MessageKey } from '../i18n';
import type { CapsuleWalletFailure } from '../capsule/protocol';

/** The toast for each failure the runtime names; each takes the site's host as `$1`. */
export const CAPSULE_FAILURE_TOASTS: Record<CapsuleWalletFailure, MessageKey> = {
  notSynced: 'capsule_failedNotSyncedToast',
  insufficientFunds: 'capsule_failedInsufficientFundsToast',
  submission: 'capsule_failedSubmissionToast',
};
