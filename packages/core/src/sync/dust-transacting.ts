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

  /** See {@link dustSpendTime}: spends are declared at the wallet's sync point. */
  override balanceTransactions(
    secretKey: ledger.DustSecretKey,
    state: CoreWallet,
    transactions: ReadonlyArray<ledger.FinalizedTransaction | ledger.UnprovenTransaction>,
    ttl: Date,
    currentTime: Date,
    ledgerParams: ledger.LedgerParameters,
  ): ReturnType<Transacting.TransactingCapabilityImplementation<ledger.FinalizedTransaction>['balanceTransactions']> {
    return super.balanceTransactions(secretKey, state, transactions, ttl, dustSpendTime(state, currentTime), ledgerParams);
  }

  /** Same point in time as the spend it previews, so the estimate matches. */
  override estimateFee(
    secretKey: ledger.DustSecretKey,
    state: CoreWallet,
    transactions: ReadonlyArray<ledger.FinalizedTransaction | ledger.UnprovenTransaction>,
    ttl: Date,
    currentTime: Date,
    ledgerParams: ledger.LedgerParameters,
  ): ReturnType<Transacting.TransactingCapabilityImplementation<ledger.FinalizedTransaction>['estimateFee']> {
    return super.estimateFee(secretKey, state, transactions, ttl, dustSpendTime(state, currentTime), ledgerParams);
  }

  /** See {@link revertDustSpends}: the SDK's revert, without the gate that defeats it. */
  override revertTransaction(
    state: CoreWallet,
    transaction: ledger.UnprovenTransaction | ledger.FinalizedTransaction,
  ): Either.Either<CoreWallet, WalletError.OtherWalletError> {
    return Either.try({
      try: () => revertDustSpends(state, transaction),
      catch: (err) =>
        new WalletError.OtherWalletError({
          message: `Error while reverting transaction ${safeFirstIdentifier(transaction)}`,
          cause: err,
        }),
    });
  }
}

function safeFirstIdentifier(transaction: {identifiers?: () => ReadonlyArray<unknown>}): string {
  try {
    return String(transaction.identifiers?.()[0] ?? '(unknown)');
  } catch {
    return '(unknown)';
  }
}

/**
 * Un-pend the dust inputs of a transaction that will not land — unconditionally.
 *
 * `DustLocalState.spend()` marks the input coin pending until `ctime + grace`
 * (three hours) and the ledger hides pending coins from `utxos`. The SDK's own
 * revert (`CoreWallet.applyFailed`) does the right thing — `processTtls(ctime +
 * grace)`, which clears the lock — but only for spends it still finds in the
 * wallet's in-memory `pendingDust` list. That list is pruned on every sync batch
 * to the nonces present in `utxos`, and `utxos` hides exactly the coin the list
 * exists to remember. So within seconds of a spend the entry is gone, and every
 * revert path is a silent no-op: the facade's revert when the node rejects the
 * submission, the SDK's TTL-expiry revert, and any inclusion watch built on top.
 *
 * Preprod, 2026-09-22 13:55Z: a fee proof was built (spend() at 13:55:18), the
 * node rejected it sixteen seconds later with InvalidDustSpendProof, a dust
 * event had arrived in between, and the ≈500 DUST coin stayed hidden for three
 * hours while the wallet reported synced.
 *
 * This applies the same `processTtls` the SDK intends, for every dust spend in
 * the transaction, without asking `pendingDust` first. Like the SDK's version it
 * also releases any older spend still pending at that time, and drops coins of
 * deregistered NIGHT that will have decayed to nothing by then — both the same
 * semantics the SDK's revert has when its gate happens to pass.
 */
export function revertDustSpends(
  wallet: CoreWallet,
  transaction: {
    readonly intents?: Map<number, {readonly dustActions?: {readonly ctime: Date; readonly spends: ReadonlyArray<{readonly oldNullifier: bigint}>} | undefined}> | undefined;
  },
): CoreWallet {
  const spends: Array<{nullifier: bigint; ctime: Date}> = [];
  for (const intent of transaction.intents?.values() ?? []) {
    const actions = intent.dustActions;
    if (!actions) continue;
    for (const spend of actions.spends ?? []) spends.push({nullifier: spend.oldNullifier, ctime: actions.ctime});
  }
  if (spends.length === 0) return wallet;

  const graceMs = Number(wallet.state.params.dustGracePeriodSeconds) * 1000;
  let ledgerState = wallet.state;
  for (const spend of spends) {
    ledgerState = ledgerState.processTtls(new Date(spend.ctime.getTime() + graceMs));
  }
  const reverted = new Set(spends.map((s) => s.nullifier));
  return {
    ...wallet,
    state: ledgerState,
    pendingDust: wallet.pendingDust.filter((coin) => !reverted.has(coin.nullifier)),
  };
}

/**
 * The time a dust spend should declare: the wallet's own sync point, not the
 * chain tip.
 *
 * The node does not verify a dust spend against its current tree root. It keeps
 * a root per block for the trailing `global_ttl` (one hour by default) and
 * verifies the proof against the root at the block at or before the spend's
 * declared `ctime` (ledger-8.1.0 `verify.rs` dust_spend_check, `root_history`).
 * The wallet's proof, in turn, commits to its local tree root, which advances
 * only as events are applied. The SDK declares `ctime` as the indexer's tip
 * block time. Whenever a dust event — anyone's spend, any NIGHT credit to a
 * registered address — has landed in a block the wallet has not yet applied,
 * the tip root and the local root differ and the node answers
 * InvalidDustSpendProof. Spartacus measured that at about one fee in fifty on
 * preprod, and both rejections it could time came within seconds of a landed
 * spend, i.e. before the view had applied the block that spend was in.
 *
 * `DustLocalState.syncTime` is the block time of the last event the wallet
 * applied, and the wallet's tree is exactly the chain's tree as of that block.
 * Declaring the spend at `syncTime` makes the node look up that same block's
 * root. The only cost is that the coin's generated value is taken as of a
 * slightly earlier moment.
 *
 * Two guards. A sync point in the future of `currentTime` cannot happen in
 * practice and is clamped. A sync point older than `maxAgeMs` is not used: past
 * `global_ttl` the node has pruned that block's root, so declaring it would
 * fail for certain, while the tip time can still succeed — if no dust event has
 * landed since, the current root equals the wallet's; if the wallet has fallen
 * behind, nothing it declares can pass and the dust view check will say so.
 */
export function dustSpendTime(
  state: {readonly state?: {readonly syncTime?: Date}} | null | undefined,
  currentTime: Date,
  maxAgeMs = DEFAULT_SYNC_POINT_MAX_AGE_MS,
): Date {
  const synced = state?.state?.syncTime;
  if (!(synced instanceof Date)) return currentTime;
  const t = synced.getTime();
  if (!Number.isFinite(t) || t <= 0) return currentTime;
  if (t >= currentTime.getTime()) return currentTime;
  if (currentTime.getTime() - t > maxAgeMs) return currentTime;
  return synced;
}

/** Comfortably inside the ledger's default one-hour root retention. */
export const DEFAULT_SYNC_POINT_MAX_AGE_MS = 45 * 60_000;

/**
 * Factory in the shape `V1Builder.withTransacting` expects — the same shape as
 * the SDK's own `makeDefaultTransactingCapability`.
 */
export const terminatingDustTransacting =
  (options: {onPass?: (pass: DustFeePass) => void} = {}) =>
  (config: Configuration, getContext: () => Context): TerminatingDustTransacting =>
    new TerminatingDustTransacting(config, getContext, options.onPass);
