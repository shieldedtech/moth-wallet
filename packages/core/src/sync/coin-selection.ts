// Which shielded coin the wallet spends next when it balances a transaction.

import {chooseCoin, type CoinSelection} from '@midnightntwrk/wallet-sdk/capabilities/balancer';

/**
 * - `smallest-first`: the SDK's default. Spends the smallest coin of the token
 *   first, then the next smallest.
 * - `largest-first`: spends the largest coin first, so a payment smaller than
 *   it needs one input.
 * - `best-fit`: spends the smallest coin that covers what is still owed on its
 *   own; if none does, the largest, and repeats.
 */
export type CoinSelectionStrategy = 'smallest-first' | 'largest-first' | 'best-fit';

export const COIN_SELECTION_STRATEGIES: readonly CoinSelectionStrategy[] = ['smallest-first', 'largest-first', 'best-fit'];

interface Coin {
  readonly type: string;
  readonly value: bigint;
}

function ofType<T extends Coin>(coins: readonly T[], tokenType: string): T[] {
  return coins.filter((c) => c.type === tokenType);
}

function largest<T extends Coin>(coins: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const c of coins) if (best === undefined || c.value > best.value) best = c;
  return best;
}

export function largestFirst<T extends Coin>(coins: readonly T[], tokenType: string): T | undefined {
  return largest(ofType(coins, tokenType));
}

/** `owed` is how much of the token the transaction still needs. */
export function bestFit<T extends Coin>(coins: readonly T[], tokenType: string, owed: bigint): T | undefined {
  const candidates = ofType(coins, tokenType);
  let fit: T | undefined;
  for (const c of candidates) if (c.value >= owed && (fit === undefined || c.value < fit.value)) fit = c;
  return fit ?? largest(candidates);
}

/** The SDK coin-selection function for a strategy. */
export function coinSelectionFor<T extends Coin>(strategy: CoinSelectionStrategy): CoinSelection<T> {
  switch (strategy) {
    case 'smallest-first':
      return (coins, tokenType) => chooseCoin(coins, tokenType);
    case 'largest-first':
      return (coins, tokenType) => largestFirst(coins, tokenType);
    case 'best-fit':
      // The SDK passes the token's current imbalance, which is negative while
      // inputs are still owed.
      return (coins, tokenType, imbalance) => bestFit(coins, tokenType, imbalance < 0n ? -imbalance : 0n);
    default: {
      const unknown: never = strategy;
      throw new Error(`Unknown coin selection strategy: ${String(unknown)}`);
    }
  }
}

export function parseCoinSelectionStrategy(value: string): CoinSelectionStrategy {
  if ((COIN_SELECTION_STRATEGIES as readonly string[]).includes(value)) return value as CoinSelectionStrategy;
  throw new Error(`coin selection must be one of: ${COIN_SELECTION_STRATEGIES.join(', ')} (got "${value}")`);
}
