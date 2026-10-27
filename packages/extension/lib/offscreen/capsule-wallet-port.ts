// The capsule runtime's wallet port over moth's synced wallet: `liveWalletPort` finds the session
// the host runs now at every use, and `healthTracked` counts each submission toward the Dust-ledger
// health diagnosis as every fee-paying submission of this wallet is, so a capsule transaction's
// rejection and a transfer's on the same seed count toward one streak.
import type { WalletPort } from '@shieldedtech/capsule-core';
import { submitWithHealthTracking, type SubmitHealthContext } from '@shieldedtech/moth-browser';

/** What the port needs of a host's sync session: the facade it runs on, which names the session. */
export interface LiveSession<F = unknown> {
  readonly facade: F;
}

/** What the port needs of the wallet it builds over one session (`SdkWallet` outside tests). */
export interface SessionWallet extends WalletPort {
  waitUntilSettled(timeoutMs: number): Promise<void>;
}

export interface LiveWalletPortOptions<F> {
  /** The host's running session for the account, started again when it was stopped: moth's `syncEnsure`. */
  readonly session: () => Promise<LiveSession<F>>;
  /** The wallet over one session's facade. */
  readonly over: (facade: F) => SessionWallet;
  /** How long a transaction waits for the session to be synced before it is balanced. */
  readonly syncWaitMs: number;
}

/**
 * A port that follows the host's live session. moth stops and restarts its sync engine under the
 * capsule host (a resync, a network edit, the idle teardown), therefore a port that kept the
 * facade it was built over would balance and submit through a stopped engine; this one asks the
 * host at every use and rebuilds its wallet when the facade has changed. A session started again
 * from the cache may still be catching up, so a transaction waits for it to be synced first.
 */
export function liveWalletPort<F>(options: LiveWalletPortOptions<F>): WalletPort {
  let built: { facade: F; wallet: SessionWallet } | undefined;
  const current = async (): Promise<SessionWallet> => {
    const { facade } = await options.session();
    if (built === undefined || built.facade !== facade) {
      built = { facade, wallet: options.over(facade) };
    }
    return built.wallet;
  };
  return {
    coinPublicKey: async () => (await current()).coinPublicKey(),
    encryptionPublicKey: async () => (await current()).encryptionPublicKey(),
    finalize: async (tx, ttl) => {
      const wallet = await current();
      await wallet.waitUntilSettled(options.syncWaitMs);
      return wallet.finalize(tx, ttl);
    },
    submit: async (tx) => (await current()).submit(tx),
  };
}

export function healthTracked(wallet: WalletPort, context: SubmitHealthContext): WalletPort {
  return {
    coinPublicKey: () => wallet.coinPublicKey(),
    encryptionPublicKey: () => wallet.encryptionPublicKey(),
    finalize: (tx, ttl) => wallet.finalize(tx, ttl),
    submit: (tx) => submitWithHealthTracking(() => wallet.submit(tx), context),
  };
}
