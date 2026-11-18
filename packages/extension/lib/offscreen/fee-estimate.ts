// A transfer's fee estimate, told apart from "not yet".
//
// Building a transfer, even just to price it, needs free coins: a DUST coin for
// the fee and the inputs of the tokens being sent. A submitted transaction
// books its inputs whole until the chain event confirming it reaches the
// wallet, and its change only arrives with that event. So a send made while an
// earlier one is still confirming can fail to estimate for no reason except
// timing, and fails the same way when submitted.

import type { WalletBalances } from '@shieldedtech/moth-browser';
import type { FeeEstimate } from '../messaging/protocol';

type Coins = WalletBalances['coins'];

/**
 * Whether a transaction this wallet submitted is still unconfirmed.
 *
 * Unshielded and DUST pending coins are inputs booked by such a transaction;
 * shielded pending coins are its own outputs (change) awaiting confirmation.
 * Coins sent by others never appear in any of the three.
 */
export function hasTransactionInFlight(coins: Coins): boolean {
  return coins.dust.pending.length > 0 || coins.unshielded.pending.length > 0 || coins.shielded.pending.length > 0;
}

/**
 * Run `estimate`, and report a failure as "waiting on an in-flight
 * transaction" when one was in flight beforehand.
 *
 * `coins` must be read before `estimate` starts: the estimate books inputs of
 * its own and releases them when it finishes, and reading afterwards could
 * mistake that booking for another transaction's.
 */
export async function estimateUnlessInFlight(coins: Coins, estimate: () => Promise<bigint>): Promise<FeeEstimate> {
  const inFlight = hasTransactionInFlight(coins);
  try {
    return { fee: (await estimate()).toString() };
  } catch (error) {
    if (inFlight) return { fee: null, reason: 'in-flight' };
    throw error;
  }
}
