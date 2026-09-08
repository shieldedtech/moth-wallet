// A DUST fee-balancing loop that terminates, replacing the wallet SDK's.
//
// The SDK's `computeBalancingRecipe` (wallet-sdk-dust-wallet, Transacting.js)
// re-selects coins until the fee of the resulting transaction is covered, but
// has no progress check, and seeds its first pass with a negative imbalance
// while seeding every later pass with a positive fee. The balancer reads a
// positive seed as a surplus, adds an output and selects nothing, so any wallet
// whose first pass under-covers its own fee spins forever — each pass building
// and proof-erasing a WASM transaction on the calling thread until the process
// dies. See docs/upstream-issues/dust-fee-balancing-nontermination.md.
//
// This module keeps the SDK's fee arithmetic (`dryRunFee`, `calculateFee` — the
// WASM parts) and replaces only the control flow: each pass covers the current
// deficit from coins not yet chosen, so every pass either converges or adds a
// coin from a finite pool. Termination is a counting argument, not a timeout.
//
// It is wired through the documented `V1Builder.withTransacting` seam. The
// coupling is to the SDK's exported implementation class and three of its
// public methods; dust-transacting.test.ts pins those so a version bump fails
// loudly rather than silently reverting to the SDK loop.

import {Either} from 'effect';
import type * as ledger from '@midnight-ntwrk/ledger-v8';
import {Transacting, WalletError, type CoinsAndBalances, type CoreWallet, type Dust} from '@midnightntwrk/wallet-sdk/dust/v1';
import {
  getBalanceRecipe,
  Imbalances,
  InsufficientFundsError as BalancingInsufficientFundsError,
} from '@midnightntwrk/wallet-sdk/capabilities/balancer';
import {largestDustCoinFirst} from './dust-coin-selection.js';

/** The smallest coin shape the loop needs; the SDK's `CoinWithValue<Dust>` satisfies it. */
export interface FeeCoin {
  readonly value: bigint;
  readonly token: {readonly nonce: unknown};
}

/** One pass of the loop, reported to `onPass` for diagnostics and tests. */
export interface DustFeePass {
  /** Which selector this pass ran under; see `balanceDustFee` on why there can be two. */
  readonly selector: 'configured' | 'largest-first-fallback';
  readonly pass: number;
  /** What the pass set out to cover: the fee target minus what was already selected. */
  readonly deficit: bigint;
  readonly added: number;
  readonly inputs: number;
  readonly coverage: bigint;
  /** The fee of the transaction as it stands after this pass's inputs were added. */
  readonly fee: bigint;
  readonly converged: boolean;
}

export interface BalanceDustFeeArgs<C extends FeeCoin> {
  readonly coins: ReadonlyArray<C>;
  /**
   * The transaction's dust imbalance at its base fee, in the ledger's sign
   * convention: negative is a deficit the wallet must cover. This is what the
   * SDK computes from `Transaction.imbalances` and seeds its first pass with.
   */
  readonly initialImbalance: bigint;
  /** The fee the transaction would carry with these dust inputs attached. */
  readonly feeFor: (inputs: ReadonlyArray<C>) => bigint;
  readonly coinSelection: CoinsAndBalances.CoinSelection;
  readonly onPass?: (pass: DustFeePass) => void;
}

export interface BalancedDustFee<C extends FeeCoin> {
  readonly fee: bigint;
  readonly inputs: ReadonlyArray<C>;
}

const sumValues = (coins: ReadonlyArray<FeeCoin>): bigint => coins.reduce((sum, coin) => sum + coin.value, 0n);

/**
 * Select dust inputs until they cover the fee of the transaction they produce.
 *
 * Each pass hands the balancer only the outstanding deficit, as a deficit, over
 * the coins not yet selected, then re-prices the transaction with everything
 * selected so far. Adding inputs can only raise the fee, so a pass that does not
 * converge has strictly increased the fee and strictly grown the input set;
 * with a finite pool that bounds the passes by the number of coins. Running out
 * of coins surfaces as the balancer's own `InsufficientFundsError`.
 *
 * Runs the configured selector first and, only if that ends in insufficient
 * funds and the configured selector is not already largest-first, retries
 * largest-first — see the note inside on why the additive loop is complete only
 * from the top.
 *
 * WASM-free: `feeFor` is injected, so tests drive this with an analytic fee
 * model and the wallet drives it with the SDK's `dryRunFee`.
 */
export function balanceDustFee<C extends FeeCoin>(args: BalanceDustFeeArgs<C>): BalancedDustFee<C> {
  const {coins, initialImbalance, feeFor, coinSelection, onPass} = args;

  // A non-negative imbalance means the transaction already carries enough dust
  // of its own. Nothing to select; report the fee it will actually pay.
  if (initialImbalance >= 0n) {
    return {fee: feeFor([]), inputs: []};
  }

  // Adding a coin raises the fee by a fixed amount, so the loop is complete —
  // finds a covering set whenever one exists — only when it takes coins from
  // the top: the k largest coins dominate every other k-subset. Under a
  // smallest-first selector it can end with the wallet's biggest coins unused
  // and report insufficient funds where the biggest coin alone would have paid
  // (seen on a devnet wallet holding 6.4e13 and 9.7e14 against a 7.3e14 fee).
  // The configured selector still runs first so a wallet's preference is
  // honoured whenever it works; largest-first is only the safety net.
  try {
    return attemptBalance(coins, initialImbalance, feeFor, coinSelection, 'configured', onPass);
  } catch (err) {
    if (!(err instanceof BalancingInsufficientFundsError)) throw err;
    // Nothing to retry when the configured selector already is largest-first —
    // which is what wallet-sync.ts wires, so this is the common case. A second
    // attempt would select the same coins in the same order, re-run `dryRunFee`
    // once per pass for the same answer, and report every pass twice.
    if (coinSelection === largestDustCoinFirst) throw err;
    return attemptBalance(coins, initialImbalance, feeFor, largestDustCoinFirst, 'largest-first-fallback', onPass);
  }
}

function attemptBalance<C extends FeeCoin>(
  coins: ReadonlyArray<C>,
  initialImbalance: bigint,
  feeFor: (inputs: ReadonlyArray<C>) => bigint,
  coinSelection: CoinsAndBalances.CoinSelection,
  selector: DustFeePass['selector'],
  onPass: ((pass: DustFeePass) => void) | undefined,
): BalancedDustFee<C> {
  const inputs: C[] = [];
  let remaining: ReadonlyArray<C> = coins;
  let fee = -initialImbalance;
  // Every non-converging pass consumes at least one coin, so this cannot be
  // reached; it turns a broken invariant into an error instead of a hang.
  const maxPasses = coins.length + 1;

  for (let pass = 1; pass <= maxPasses; pass++) {
    const deficit = fee - sumValues(inputs);
    if (deficit <= 0n) {
      return {fee, inputs};
    }

    const recipe = getBalanceRecipe({
      coins: remaining.map((coin) => ({type: 'dust', value: coin.value, token: coin.token})),
      initialImbalances: Imbalances.fromEntry('dust', -deficit),
      feeTokenType: 'dust',
      coinSelection,
      transactionCostModel: {inputFeeOverhead: 0n, outputFeeOverhead: 0n},
      createOutput: (coin) => coin,
      isCoinEqual: (a, b) => a.token.nonce === b.token.nonce,
    });
    // The balancer throws when the pool cannot cover the deficit, so an empty
    // selection here would be a selector returning nothing on a non-empty pool.
    // Either way there is no path to convergence.
    if (recipe.inputs.length === 0) {
      throw new BalancingInsufficientFundsError('dust');
    }

    const chosen = new Set(recipe.inputs.map((input) => input.token.nonce));
    for (const coin of remaining) {
      if (chosen.has(coin.token.nonce)) inputs.push(coin);
    }
    remaining = remaining.filter((coin) => !chosen.has(coin.token.nonce));

    const coverage = sumValues(inputs);
    const newFee = feeFor(inputs);
    const converged = newFee <= coverage;
    onPass?.({selector, pass, deficit, added: recipe.inputs.length, inputs: inputs.length, coverage, fee: newFee, converged});
    if (converged) {
      return {fee: newFee, inputs};
    }
    fee = newFee;
  }

  throw new Error(`DUST fee balancing did not converge after ${maxPasses} passes`);
}

/**
 * Mirror of the SDK's module-private helper: each input pays as much of the fee
 * as it can, in selection order, so the last input pays only the remainder.
 */
export function distributeFeeAcrossInputs<C extends FeeCoin>(inputs: ReadonlyArray<C>, fee: bigint): C[] {
  let remaining = fee;
  return inputs.map((input) => {
    const deduction = remaining >= input.value ? input.value : remaining;
    remaining -= deduction;
    return {...input, value: deduction};
  });
}

/** Mirror of the SDK's static `feeImbalance`: the dust entry of the transaction's imbalances at `totalFee`. */
function dustImbalance(transaction: ledger.FinalizedTransaction | ledger.UnprovenTransaction, totalFee: bigint): bigint {
  for (const [tokenType, imbalance] of transaction.imbalances(0, totalFee).entries()) {
    if (tokenType.tag === 'dust') return imbalance;
  }
  return 0n;
}

type Configuration = Transacting.DefaultTransactingConfiguration;
type Context = Transacting.DefaultTransactingContext;

/**
 * The SDK's transacting capability with `computeBalancingRecipe` replaced by
 * `balanceDustFee`. `estimateFee` and `balanceTransactions` both route through
 * that one method, so both the fee preview and the real spend take this path.
 */
export class TerminatingDustTransacting extends Transacting.TransactingCapabilityImplementation<ledger.FinalizedTransaction> {
  readonly #onPass: ((pass: DustFeePass) => void) | undefined;

  constructor(config: Configuration, getContext: () => Context, onPass?: (pass: DustFeePass) => void) {
    super(
      config.networkId,
      config.costParameters,
      () => getContext().coinSelection,
      () => getContext().coinsAndBalancesCapability,
      () => getContext().keysCapability,
    );
    this.#onPass = onPass;
  }

  override computeBalancingRecipe(
    secretKey: ledger.DustSecretKey,
    state: CoreWallet,
    transactions: ReadonlyArray<ledger.FinalizedTransaction | ledger.UnprovenTransaction>,
    ttl: Date,
    currentTime: Date,
    ledgerParams: ledger.LedgerParameters,
  ): Either.Either<
    {fee: bigint; recipeInputs: ReadonlyArray<CoinsAndBalances.CoinWithValue<Dust>>},
    WalletError.InsufficientFundsError | WalletError.OtherWalletError
  > {
    return Either.try({
      try: () => {
        const initialImbalance = transactions.reduce(
          (total, transaction) => total + dustImbalance(transaction, this.calculateFee(transaction, ledgerParams)),
          0n,
        );
        const coins = this.getCoins().getAvailableCoinsWithGeneratedDust(state, currentTime);
        const {fee, inputs} = balanceDustFee({
          coins,
          initialImbalance,
          coinSelection: this.getCoinSelection(),
          feeFor: (chosen) => this.dryRunFee(chosen, transactions, secretKey, state, ttl, currentTime, ledgerParams),
          onPass: this.#onPass,
        });
        return {fee, recipeInputs: distributeFeeAcrossInputs(inputs, fee)};
      },
      // Same mapping as the SDK, so callers see the same error types they do today.
      catch: (err) =>
        err instanceof BalancingInsufficientFundsError
          ? new WalletError.InsufficientFundsError({message: err.message, tokenType: err.tokenType})
          : new WalletError.OtherWalletError({
              message: err instanceof Error ? err.message : 'Dust balancing failed',
              cause: err,
            }),
    });
  }
}

/**
 * Factory in the shape `V1Builder.withTransacting` expects — the same shape as
 * the SDK's own `makeDefaultTransactingCapability`.
 */
export const terminatingDustTransacting =
  (options: {onPass?: (pass: DustFeePass) => void} = {}) =>
  (config: Configuration, getContext: () => Context): TerminatingDustTransacting =>
    new TerminatingDustTransacting(config, getContext, options.onPass);
