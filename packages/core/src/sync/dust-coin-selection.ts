// DUST fee-coin selection for the dust wallet's balancing loop.
//
// WASM-free on purpose: the selector is pure bigint arithmetic, so it can be
// unit-tested without loading the ledger — the same split as progress.ts.

import type {CoinsAndBalances} from '@midnightntwrk/wallet-sdk/dust/v1';

/**
 * Picks the highest-value DUST coin to pay a fee from, replacing the SDK's
 * smallest-first default.
 *
 * `computeBalancingRecipe` re-runs selection in a loop that exits only once the
 * selected coins cover the fee that selecting them produced. Smallest-first
 * spends many coins to reach the fee, which raises the fee; the loop's second
 * iteration is then fed a positive fee where the first was fed a negative
 * imbalance, so it selects nothing and spins forever, deserialising a WASM
 * transaction per pass. Choosing the largest coin makes the first iteration
 * cover the fee outright, which is the one case that terminates. See
 * docs/upstream-issues/dust-fee-balancing-nontermination.md.
 *
 * A DUST spend is one-in-one-out — the ledger nullifies the coin and mints a
 * successor worth the remainder — so draining the fullest coin neither splits
 * coins nor grows the UTXO set, and rotates naturally as drained coins
 * regenerate.
 */
export const largestDustCoinFirst: CoinsAndBalances.CoinSelection = (coins) =>
  coins
    // A zero-value coin cannot pay any part of a fee, and the SDK's default
    // selector excludes it too; keeping the filter preserves the
    // insufficient-funds path on a wallet whose dust has not yet generated.
    .filter((coin) => coin.value > 0n)
    // Sorting the array `filter` just returned, so the caller's is untouched.
    // Compared as bigints rather than cast through Number: DUST values run well
    // past 2^53, so a numeric difference is not exactly representable.
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
    .at(0);
