// The capsule runtime's wallet port over moth's synced wallet, with each submission counted by the
// Dust-ledger health diagnosis as every fee-paying submission of this wallet is: a capsule
// transaction's rejection and a transfer's on the same seed count toward one streak, and a wedged
// devnet dust ledger is named as such to the runtime rather than as one more raw rejection.
import type { WalletPort } from '@shieldedtech/capsule-core';
import { submitWithHealthTracking, type SubmitHealthContext } from '@shieldedtech/moth-browser';

export function healthTracked(wallet: WalletPort, context: SubmitHealthContext): WalletPort {
  return {
    coinPublicKey: () => wallet.coinPublicKey(),
    encryptionPublicKey: () => wallet.encryptionPublicKey(),
    finalize: (tx, ttl) => wallet.finalize(tx, ttl),
    submit: (tx) => submitWithHealthTracking(() => wallet.submit(tx), context),
  };
}
