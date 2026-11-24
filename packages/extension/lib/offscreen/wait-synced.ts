import type { WalletBalances } from '@shieldedtech/moth-browser';

export interface BalanceSource {
  balances: WalletBalances;
  subscribe(listener: (balances: WalletBalances) => void): () => void;
}

/** The facade's live verdict: every sub-wallet complete and the indexer connected right now. */
export const syncedNow = (balances: WalletBalances): boolean => balances.synced;

/**
 * Every sub-wallet has been strictly complete at some point this session.
 *
 * The SDK's per-sub-wallet completeness requires the indexer connection as well,
 * but core carries each flag forward for the session once it has been reached. A
 * fresh session starts them false, and restored state starts disconnected, so a
 * wallet whose sync engine has only just started still reads not ready. A wallet
 * that caught up and then lost its indexer connection stays ready, and builds from
 * the state it already has instead of timing out.
 */
export const caughtUpThisSession = (balances: WalletBalances): boolean => {
  if (balances.synced) return true;
  const progress = balances.syncProgress;
  return Boolean(progress?.shieldedSynced && progress.unshieldedSynced && progress.dustSynced);
};

/**
 * Wait for a balance snapshot that `isReady` accepts, without assuming
 * subscribe() is lazy. The wallet SDK can invoke the listener synchronously,
 * before subscribe() returns its cleanup function, when a cached snapshot
 * becomes ready between the initial read and listener registration.
 */
export function waitForSyncedBalances(
  source: BalanceSource,
  timeoutMs: number,
  isReady: (balances: WalletBalances) => boolean = syncedNow,
): Promise<WalletBalances> {
  if (isReady(source.balances)) return Promise.resolve(source.balances);

  return new Promise<WalletBalances>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      reject(new Error('Wallet sync did not complete in time'));
    }, timeoutMs);

    try {
      const stop = source.subscribe((balances) => {
        if (!isReady(balances) || settled) return;
        settled = true;
        clearTimeout(timer);
        // When subscribe() emits synchronously, `stop` has not been returned
        // yet. The post-subscribe settled check below performs cleanup then.
        unsubscribe?.();
        resolve(balances);
      });
      unsubscribe = stop;
      if (settled) stop();
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}
