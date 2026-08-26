import { balancesSettled, type WalletBalances } from '@shieldedtech/moth-browser';

export interface BalanceSource {
  balances: WalletBalances;
  subscribe(listener: (balances: WalletBalances) => void): () => void;
}

/**
 * Wait for a settled balance snapshot without assuming subscribe() is lazy.
 * The wallet SDK can invoke the listener synchronously, before subscribe()
 * returns its cleanup function, when a cached snapshot becomes ready between
 * the initial read and listener registration.
 *
 * Settled, not `balances.synced`: that flag is built from `isStrictlyComplete()`,
 * which is false forever for an EMPTY stream — so an account that has never held
 * a shielded coin never sets it, and this rejected with "did not complete in
 * time" while holding correct balances. See `balancesSettled` in core.
 */
export function waitForSyncedBalances(
  source: BalanceSource,
  timeoutMs: number,
): Promise<WalletBalances> {
  if (balancesSettled(source.balances)) return Promise.resolve(source.balances);

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
        if (!balancesSettled(balances) || settled) return;
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
