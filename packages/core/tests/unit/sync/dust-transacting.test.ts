import {describe, it, expect, vi} from 'vitest';
import {Either} from 'effect';
import {Transacting, WalletError, CoinsAndBalances} from '@midnightntwrk/wallet-sdk/dust/v1';
import {
  balanceDustFee,
  distributeFeeAcrossInputs,
  TerminatingDustTransacting,
  terminatingDustTransacting,
  type DustFeePass,
  type FeeCoin,
} from '../../../src/sync/dust-transacting.js';

type Coin = {value: bigint; token: {nonce: string}};
const coin = (value: bigint, n: number): Coin => ({value, token: {nonce: String(n).padStart(64, '0')}});

// The SDK's default selector, smallest coin first — the order that walks the
// SDK's own loop into non-termination. Used here to show the loop, not the
// selector, is what decides whether balancing ends.
const smallestFirst = CoinsAndBalances.chooseCoin;

// Analytic stand-in for `dryRunFee`: a base cost plus a per-dust-spend
// increment, the one property of the real fee that matters to the loop.
const FEE_BASE = 1_400_000_000_000_000n;
const FEE_PER_SPEND = 3_750_000_000_000n;
const feeFor = (inputs: ReadonlyArray<FeeCoin>): bigint => FEE_BASE + FEE_PER_SPEND * BigInt(inputs.length);

// Twelve part-drained coins beside two near their generation cap — the wallet
// shape on which the SDK loop spins (see dust-coin-selection.test.ts).
const drained = Array.from({length: 12}, (_, k) => coin(176_250_000_000_000n, k));
const full = [coin(50_000_000_000_000_000n, 90), coin(30_000_000_000_000_000n, 91)];

describe('balanceDustFee', () => {
  it('converges with smallest-first on the wallet the SDK loop spins on', () => {
    const passes: DustFeePass[] = [];
    const result = balanceDustFee({
      coins: [...drained, ...full],
      initialImbalance: -feeFor([]),
      feeFor,
      coinSelection: smallestFirst,
      onPass: (p) => passes.push(p),
    });

    // Pass 1 selects eight drained coins and under-covers the fee they cost —
    // the exact state the SDK loop never escapes. Pass 2 covers the shortfall
    // with one more coin and converges.
    expect(passes.map((p) => ({pass: p.pass, added: p.added, converged: p.converged}))).toEqual([
      {pass: 1, added: 8, converged: false},
      {pass: 2, added: 1, converged: true},
    ]);
    expect(result.inputs).toHaveLength(9);
    expect(result.fee).toBe(feeFor(result.inputs));
    expect(result.fee).toBeLessThanOrEqual(result.inputs.reduce((s, c) => s + c.value, 0n));
  });

  it('converges on a uniformly tiny wallet, which no selection order can rescue', () => {
    const uniformlyTiny = Array.from({length: 12}, (_, k) => coin(176_250_000_000_000n, k));
    const passes: DustFeePass[] = [];
    const result = balanceDustFee({
      coins: uniformlyTiny,
      initialImbalance: -feeFor([]),
      feeFor,
      coinSelection: smallestFirst,
      onPass: (p) => passes.push(p),
    });

    expect(passes.at(-1)?.converged).toBe(true);
    expect(passes.length).toBeLessThanOrEqual(uniformlyTiny.length);
    expect(result.inputs.reduce((s, c) => s + c.value, 0n)).toBeGreaterThanOrEqual(result.fee);
  });

  it('never re-selects a coin and grows the input set every pass', () => {
    const passes: DustFeePass[] = [];
    const result = balanceDustFee({
      coins: [...drained, ...full],
      initialImbalance: -feeFor([]),
      feeFor,
      coinSelection: smallestFirst,
      onPass: (p) => passes.push(p),
    });
    const nonces = result.inputs.map((c) => c.token.nonce);
    expect(new Set(nonces).size).toBe(nonces.length);
    for (let i = 1; i < passes.length; i++) {
      expect(passes[i]!.inputs).toBeGreaterThan(passes[i - 1]!.inputs);
      expect(passes[i]!.fee).toBeGreaterThan(passes[i - 1]!.fee - FEE_PER_SPEND); // fee is monotone in inputs
    }
  });

  it('fails with the balancer insufficient-funds error when the pool cannot cover the fee', () => {
    expect(() =>
      balanceDustFee({coins: [coin(1n, 0), coin(2n, 1)], initialImbalance: -feeFor([]), feeFor, coinSelection: smallestFirst}),
    ).toThrowError(/dust/i);
  });

  it('rescues a selector that picks nothing from a non-empty pool via the fallback', () => {
    // Under the SDK loop a selector returning undefined is an immediate
    // InsufficientFundsError; here the largest-first fallback gets a turn first.
    const picksNothing: CoinsAndBalances.CoinSelection = () => undefined;
    const passes: DustFeePass[] = [];
    const result = balanceDustFee({
      coins: [...full],
      initialImbalance: -feeFor([]),
      feeFor,
      coinSelection: picksNothing,
      onPass: (p) => passes.push(p),
    });
    expect(passes.map((p) => p.selector)).toEqual(['largest-first-fallback']);
    expect(result.inputs).toHaveLength(1);
  });

  it('selects nothing when the transaction already carries enough dust', () => {
    const feeSpy = vi.fn(feeFor);
    const result = balanceDustFee({coins: [...full], initialImbalance: 5n, feeFor: feeSpy, coinSelection: smallestFirst});
    expect(result.inputs).toEqual([]);
    expect(result.fee).toBe(feeFor([]));
    expect(feeSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to largest-first when smallest-first strands the coin that could pay', () => {
    // Real coin set from a devnet wallet minutes after registration, with the
    // real fee model of that chain: base 3.66e14, +3.36e14 per dust input.
    // Smallest-first takes 6.4e13, must add 9.7e14, and fee(2)=1.037e15 exceeds
    // the wallet's entire 1.031e15 — but 9.7e14 alone covers fee(1)=7.3e14.
    const devnetFee = (inputs: ReadonlyArray<FeeCoin>): bigint => 365_895_829_713_385n + 335_638_367_806_065n * BigInt(inputs.length);
    const wallet = [coin(64_165_147_200_000n, 0), coin(967_238_395_877_943n, 1)];
    const passes: DustFeePass[] = [];
    const result = balanceDustFee({
      coins: wallet,
      initialImbalance: -devnetFee([]),
      feeFor: devnetFee,
      coinSelection: smallestFirst,
      onPass: (p) => passes.push(p),
    });
    expect(passes.map((p) => [p.selector, p.pass, p.inputs, p.converged])).toEqual([
      ['configured', 1, 2, false],
      ['largest-first-fallback', 1, 1, true],
    ]);
    expect(result.inputs.map((c) => c.value)).toEqual([967_238_395_877_943n]);
    expect(result.fee).toBe(devnetFee(result.inputs));
  });

  it('reports insufficient funds when no order of the pool can pay', () => {
    // Coins so small the balancer throws before a pass completes, under both
    // the configured selector and the fallback; the error is the SDK's own.
    expect(() =>
      balanceDustFee({coins: [coin(1n, 0), coin(2n, 1)], initialImbalance: -feeFor([]), feeFor, coinSelection: smallestFirst}),
    ).toThrowError(/dust/i);
  });

  it('converges on the first pass when one coin covers the fee', () => {
    const passes: DustFeePass[] = [];
    const largestFirst: CoinsAndBalances.CoinSelection = (coins) =>
      [...coins].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0)).at(0);
    balanceDustFee({
      coins: [...drained, ...full],
      initialImbalance: -feeFor([]),
      feeFor,
      coinSelection: largestFirst,
      onPass: (p) => passes.push(p),
    });
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({added: 1, converged: true});
  });
});

describe('distributeFeeAcrossInputs', () => {
  it('drains inputs in order and charges the last one only the remainder', () => {
    const out = distributeFeeAcrossInputs([coin(10n, 0), coin(10n, 1), coin(10n, 2)], 25n);
    expect(out.map((c) => c.value)).toEqual([10n, 10n, 5n]);
    expect(out.map((c) => c.token.nonce)).toEqual([0, 1, 2].map((n) => String(n).padStart(64, '0')));
  });
});

// A fake ledger transaction: the only thing `computeBalancingRecipe` asks of it
// directly is its dust imbalance at a given fee.
const fakeTransaction = (): unknown => ({
  imbalances: (_segment: number, fee: bigint) => new Map([[{tag: 'dust'}, -fee]]),
});

// Test double over the real class: swaps the two WASM-backed methods for the
// analytic fee model and leaves everything else — including the override under
// test and its error mapping — exactly as shipped.
class TestableTransacting extends TerminatingDustTransacting {
  override calculateFee(): bigint {
    return feeFor([]);
  }
  override dryRunFee(recipeInputs: ReadonlyArray<FeeCoin>): bigint {
    return feeFor(recipeInputs);
  }
}

const context = (coins: ReadonlyArray<Coin>, coinSelection: CoinsAndBalances.CoinSelection = smallestFirst) =>
  () =>
    ({
      coinSelection,
      coinsAndBalancesCapability: {getAvailableCoinsWithGeneratedDust: () => coins},
      keysCapability: {},
    }) as unknown as Transacting.DefaultTransactingContext;

const config = {networkId: 'undeployed', costParameters: {feeBlocksMargin: 5}} as unknown as Transacting.DefaultTransactingConfiguration;
const ledgerArgs = [undefined, undefined, [fakeTransaction()], new Date(), new Date(), undefined] as unknown as Parameters<
  TerminatingDustTransacting['computeBalancingRecipe']
>;

describe('TerminatingDustTransacting', () => {
  it('returns a recipe whose distributed inputs sum exactly to the fee', () => {
    const passes: DustFeePass[] = [];
    const cap = new TestableTransacting(config, context([...drained, ...full]), (p) => passes.push(p));
    const result = cap.computeBalancingRecipe(...ledgerArgs);

    expect(Either.isRight(result)).toBe(true);
    if (!Either.isRight(result)) return;
    expect(passes).toHaveLength(2);
    expect(result.right.fee).toBe(feeFor(result.right.recipeInputs));
    expect(result.right.recipeInputs.reduce((s, c) => s + c.value, 0n)).toBe(result.right.fee);
  });

  it('maps an uncoverable fee to the SDK InsufficientFundsError, not a hang', () => {
    const cap = new TestableTransacting(config, context([coin(1n, 0)]));
    const result = cap.computeBalancingRecipe(...ledgerArgs);
    expect(Either.isLeft(result)).toBe(true);
    if (!Either.isLeft(result)) return;
    expect(result.left).toBeInstanceOf(WalletError.InsufficientFundsError);
    expect(result.left).toMatchObject({tokenType: 'dust'});
  });

  it('maps any other failure to OtherWalletError with the cause attached', () => {
    class Exploding extends TestableTransacting {
      override dryRunFee(): bigint {
        throw new Error('ledger exploded');
      }
    }
    const result = new Exploding(config, context([...full])).computeBalancingRecipe(...ledgerArgs);
    expect(Either.isLeft(result)).toBe(true);
    if (!Either.isLeft(result)) return;
    expect(result.left).toBeInstanceOf(WalletError.OtherWalletError);
    expect(result.left.message).toBe('ledger exploded');
  });

  it('reaches both estimateFee and balanceTransactions through the override', () => {
    // The fix only holds if the SDK still routes both entry points through
    // computeBalancingRecipe. A spy on the override is the direct check.
    const cap = new TestableTransacting(config, context([...full]));
    const spy = vi.spyOn(cap, 'computeBalancingRecipe');
    const estimate = cap.estimateFee(...(ledgerArgs as unknown as Parameters<typeof cap.estimateFee>));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(Either.isRight(estimate)).toBe(true);
    // balanceTransactions goes on to build a real ledger intent; a rejected
    // Either from the spy is enough to prove the routing without WASM.
    spy.mockReturnValueOnce(Either.left(new WalletError.OtherWalletError({message: 'routed', cause: undefined})));
    const balanced = cap.balanceTransactions(...(ledgerArgs as unknown as Parameters<typeof cap.balanceTransactions>));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(Either.isLeft(balanced) && balanced.left.message).toBe('routed');
  });

  it('builds through the factory shape V1Builder.withTransacting expects', () => {
    const cap = terminatingDustTransacting()(config, context([...full]));
    expect(cap).toBeInstanceOf(TerminatingDustTransacting);
    expect(cap).toBeInstanceOf(Transacting.TransactingCapabilityImplementation);
  });
});

describe('SDK surface this module depends on', () => {
  // These are the internals the override reaches for. If an SDK bump removes
  // or renames one, this fails here instead of at a user's first transfer.
  it('still exposes the implementation class and the members the override uses', () => {
    const proto = Transacting.TransactingCapabilityImplementation.prototype as Record<string, unknown>;
    for (const member of ['computeBalancingRecipe', 'dryRunFee', 'calculateFee', 'estimateFee', 'balanceTransactions']) {
      expect(typeof proto[member], member).toBe('function');
    }
    expect(Transacting.TransactingCapabilityImplementation.length).toBe(5);
  });
});
