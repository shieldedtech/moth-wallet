import {describe, it, expect} from 'vitest';
import {getBalanceRecipe, Imbalances} from '@midnightntwrk/wallet-sdk/capabilities/balancer';
import {CoinsAndBalances} from '@midnightntwrk/wallet-sdk/dust/v1';
import {largestDustCoinFirst} from '../../../src/sync/dust-coin-selection.js';

type Coin = {type: string; value: bigint; token: {nonce: string}};

const nonce = (n: number): {nonce: string} => ({nonce: String(n).padStart(64, '0')});
const coin = (value: bigint, n: number): Coin => ({type: 'dust', value, token: nonce(n)});

describe('largestDustCoinFirst', () => {
  it('picks the largest from a mix of tiny and huge values', () => {
    const coins = [
      coin(1n, 0),
      coin(176_250_000_000_000n, 1),
      coin(50_000_000_000_000_000n, 2),
      coin(30_000_000_000_000_000n, 3),
      coin(2n, 4),
    ];
    expect(largestDustCoinFirst(coins)?.value).toBe(50_000_000_000_000_000n);
  });

  it('orders values that collide when cast individually to Number', () => {
    // 2^60 is exactly representable as a double and 2^60 + 1 is not, so
    // `Number(a.value) - Number(b.value)` is 0 for this pair and a comparator
    // written that way would keep the smaller coin at the head. The smaller one
    // is listed first so that mistake fails this assertion rather than passing
    // by luck.
    const coins = [coin(1_152_921_504_606_846_976n, 0), coin(1_152_921_504_606_846_977n, 1)];
    expect(Number(coins[0]!.value)).toBe(Number(coins[1]!.value));
    expect(largestDustCoinFirst(coins)?.value).toBe(1_152_921_504_606_846_977n);
  });

  it('ignores zero-value coins and reports nothing when every coin is empty', () => {
    expect(largestDustCoinFirst([coin(0n, 0), coin(7n, 1), coin(0n, 2)])?.value).toBe(7n);
    expect(largestDustCoinFirst([coin(0n, 0), coin(0n, 1)])).toBeUndefined();
    expect(largestDustCoinFirst([])).toBeUndefined();
  });

  it('leaves the caller-owned coin array untouched', () => {
    const coins = [coin(1n, 0), coin(9n, 1), coin(5n, 2)];
    largestDustCoinFirst(coins);
    expect(coins.map((c) => c.value)).toEqual([1n, 9n, 5n]);
  });
});

// Regression guard for the upstream non-termination this selector works around:
// see docs/upstream-issues/dust-fee-balancing-nontermination.md.
//
// This drives the REAL `getBalanceRecipe` and the REAL SDK default selector
// through the same loop shape as
// `TransactingCapabilityImplementation.computeBalancingRecipe`. Only the fee
// oracle is modelled — the SDK's `dryRunFee` builds and erases a WASM
// transaction, which is exactly the cost that makes the spin fatal, and which a
// unit test has no business doing. The fee model reproduces its one relevant
// property: the fee grows with the number of dust spends.
describe('dust fee balancing loop', () => {
  const FEE_BASE = 1_400_000_000_000_000n;
  const FEE_PER_SPEND = 3_750_000_000_000n;
  const feeFor = (inputCount: number): bigint => FEE_BASE + FEE_PER_SPEND * BigInt(inputCount);

  type Iteration = {inputs: number; coverage: bigint; newFee: bigint; converged: boolean};

  const runLoop = (
    coins: readonly Coin[],
    coinSelection: typeof largestDustCoinFirst,
    maxIterations = 8,
  ): {iterations: Iteration[]; outcome: 'converged' | 'insufficient-funds' | 'never-converged'} => {
    // Iteration 1 is fed the ledger's dust imbalance, which is negative; every
    // later iteration is fed the previous pass's fee, which is positive. That
    // sign flip is the upstream defect this loop exists to demonstrate.
    let currentFee = -feeFor(0);
    const iterations: Iteration[] = [];
    for (let i = 0; i < maxIterations; i++) {
      let recipe;
      try {
        recipe = getBalanceRecipe({
          coins: coins.map((c) => ({type: 'dust', value: c.value, token: c.token})),
          initialImbalances: Imbalances.fromEntry('dust', currentFee),
          feeTokenType: 'dust',
          coinSelection,
          transactionCostModel: {inputFeeOverhead: 0n, outputFeeOverhead: 0n},
          createOutput: (c) => c,
          isCoinEqual: (a, b) => a.token.nonce === b.token.nonce,
        } as Parameters<typeof getBalanceRecipe>[0]);
      } catch {
        return {iterations, outcome: 'insufficient-funds'};
      }
      const inputs = recipe.inputs as ReadonlyArray<{value: bigint}>;
      const coverage = inputs.reduce((sum, input) => sum + input.value, 0n);
      const newFee = feeFor(inputs.length);
      const converged = newFee <= coverage;
      iterations.push({inputs: inputs.length, coverage, newFee, converged});
      if (converged) return {iterations, outcome: 'converged'};
      currentFee = newFee;
    }
    return {iterations, outcome: 'never-converged'};
  };

  // Twelve part-drained coins whose combined value comfortably covers any fee,
  // beside two that have generated close to their cap.
  const drained = Array.from({length: 12}, (_, k) => coin(176_250_000_000_000n, k));
  const full = [coin(50_000_000_000_000_000n, 90), coin(30_000_000_000_000_000n, 91)];
  const wallet = [...drained, ...full];

  it('never terminates under the SDK default, selecting nothing after the first pass', () => {
    const {iterations, outcome} = runLoop(wallet, CoinsAndBalances.chooseCoin);

    expect(outcome).toBe('never-converged');

    // Pass 1 spends eight drained coins and still falls short of the fee that
    // spending eight coins costs.
    expect(iterations[0]).toMatchObject({inputs: 8, converged: false});
    expect(iterations[0]!.coverage).toBeLessThan(iterations[0]!.newFee);

    // Every later pass is handed a positive fee, takes the balancer's
    // add-an-output branch instead of selecting inputs, and so is identical to
    // the one before it. Nothing about the loop state can change again.
    for (const iteration of iterations.slice(1)) {
      expect(iteration).toMatchObject({inputs: 0, coverage: 0n, converged: false});
    }
  });

  it('converges on the first pass under largest-first', () => {
    const {iterations, outcome} = runLoop(wallet, largestDustCoinFirst);

    expect(outcome).toBe('converged');
    expect(iterations).toHaveLength(1);
    expect(iterations[0]!.inputs).toBe(1);
    expect(iterations[0]!.coverage).toBe(50_000_000_000_000_000n);
  });

  it('still cannot terminate when every coin is far smaller than the fee', () => {
    // The boundary of this workaround, pinned deliberately. Largest-first
    // converges because taking the biggest coin overshoots the fee in one pass;
    // a wallet whose dust is spread evenly across coins that are all far below
    // fee size has no such coin, needs eight of them, and spins exactly as the
    // SDK default does. Only a progress check upstream fixes that case — see
    // docs/upstream-issues/dust-fee-balancing-nontermination.md.
    const uniformlyTiny = Array.from({length: 12}, (_, k) => coin(176_250_000_000_000n, k));
    const {iterations, outcome} = runLoop(uniformlyTiny, largestDustCoinFirst);

    expect(outcome).toBe('never-converged');
    expect(iterations[0]).toMatchObject({inputs: 8, converged: false});

    // One coin at fee size is enough to recover the terminating case.
    const withOneFeeSizedCoin = [coin(1_500_000_000_000_000n, 99), ...uniformlyTiny];
    expect(runLoop(withOneFeeSizedCoin, largestDustCoinFirst)).toMatchObject({
      outcome: 'converged',
      iterations: [{inputs: 1, converged: true}],
    });
  });

  it('still reports insufficient funds when no coin can cover the fee', () => {
    // Largest-first must not paper over a genuinely unaffordable transaction:
    // the loop has to reach the balancer's insufficient-funds path, not spin.
    const {outcome} = runLoop([coin(1n, 0), coin(2n, 1)], largestDustCoinFirst);
    expect(outcome).toBe('insufficient-funds');
  });
});
