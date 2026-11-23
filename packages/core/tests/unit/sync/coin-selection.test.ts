import {describe, expect, it} from 'vitest';
import {getBalanceRecipe} from '@midnightntwrk/wallet-sdk/capabilities/balancer';
import {
  bestFit,
  coinSelectionFor,
  largestFirst,
  parseCoinSelectionStrategy,
  type CoinSelectionStrategy,
} from '../../../src/sync/coin-selection.js';

const T = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);
type C = {type: string; value: bigint; id: number};
const coin = (id: number, value: bigint, type = T): C => ({type, value, id});

/** Balance a payment of `amount` of T with the SDK's own balancer. */
function balance(coins: C[], amount: bigint, strategy: CoinSelectionStrategy) {
  return getBalanceRecipe<C, {type: string; value: bigint}>({
    coins,
    initialImbalances: new Map([[T, -amount]]),
    transactionCostModel: {inputFeeOverhead: 0n, outputFeeOverhead: 0n},
    feeTokenType: 'dust',
    createOutput: (c) => c,
    isCoinEqual: (a, b) => a.id === b.id,
    coinSelection: coinSelectionFor<C>(strategy),
  });
}

const wallet = [coin(1, 5n), coin(2, 40n), coin(3, 100n), coin(4, 1_000n, OTHER), coin(5, 60n)];

describe('coin selection', () => {
  it('largest-first takes the largest coin of the token', () => {
    expect(largestFirst(wallet, T)?.id).toBe(3);
    expect(largestFirst(wallet, 'cc')).toBeUndefined();
  });

  it('best-fit takes the smallest coin that covers the amount, else the largest', () => {
    expect(bestFit(wallet, T, 50n)?.id).toBe(5);
    expect(bestFit(wallet, T, 40n)?.id).toBe(2);
    expect(bestFit(wallet, T, 101n)?.id).toBe(3);
  });

  it.each([
    ['smallest-first', [1, 2, 5]],
    ['largest-first', [3]],
    ['best-fit', [5]],
  ] as const)('%s, through the SDK balancer, pays 50 with inputs %j', (strategy, ids) => {
    const recipe = balance(wallet, 50n, strategy);
    expect(recipe.inputs.map((c) => c.id)).toEqual(ids);
    const paid = recipe.inputs.reduce((s, c) => s + c.value, 0n);
    const change = recipe.outputs.reduce((s, c) => s + c.value, 0n);
    expect(paid - change).toBe(50n);
  });

  it('best-fit falls back to several coins when none covers the amount', () => {
    const recipe = balance(wallet, 150n, 'best-fit');
    expect(recipe.inputs.map((c) => c.id)).toEqual([3, 5]);
  });

  it('keeps one-input payments possible over many self-sends where smallest-first cannot', () => {
    // Each round pays itself between a tenth and a half of what it can pay
    // with one input. With smallest-first that is bounded by the smallest
    // coin, which each round splits, so it shrinks until a payment would round
    // to nothing. The others are bounded by the largest coin.
    const rounds = (strategy: CoinSelectionStrategy) => {
      let coins: C[] = [coin(0, 10n ** 12n)];
      let next = 1;
      for (let i = 0; i < 200; i++) {
        const values = coins.map((c) => c.value);
        const bound = strategy === 'smallest-first' ? values.reduce((a, b) => (b < a ? b : a)) : values.reduce((a, b) => (b > a ? b : a));
        const amount = (bound * BigInt(10 + ((i * 37) % 41))) / 100n;
        if (amount === 0n) return i;
        const recipe = balance(coins, amount, strategy);
        if (recipe.inputs.length !== 1) return i;
        const spent = new Set(recipe.inputs.map((c) => c.id));
        coins = coins.filter((c) => !spent.has(c.id));
        coins.push(coin(next++, amount), ...recipe.outputs.map((o) => coin(next++, o.value)));
      }
      return 200;
    };
    expect(rounds('smallest-first')).toBeLessThan(60);
    expect(rounds('largest-first')).toBe(200);
    expect(rounds('best-fit')).toBe(200);
  });

  it('parses strategy names', () => {
    expect(parseCoinSelectionStrategy('best-fit')).toBe('best-fit');
    expect(() => parseCoinSelectionStrategy('random')).toThrow(/smallest-first, largest-first, best-fit/);
  });
});
