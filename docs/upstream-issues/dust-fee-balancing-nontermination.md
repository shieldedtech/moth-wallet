---
status: draft — ready to file
target-repos: midnightntwrk/midnight-wallet
last-updated: 2026-09-08
---

# Draft upstream issue: DUST fee balancing cannot terminate, and only its first iteration can ever converge

This is a ready-to-paste GitHub issue body. It concerns the wallet SDK's dust
fee-balancing loop, not the ledger or the node. Moth ships a client-side
mitigation (linked at the bottom) that makes the terminating case the common
one; it does not and cannot fix the loop itself.

---

## Title

`computeBalancingRecipe` spins forever when the first balancing pass under-covers its own fee, because every later pass is fed a fee where the first was fed an imbalance

## Environment

| Component | Version |
|---|---|
| `@midnightntwrk/wallet-sdk` | `1.2.0` |
| `@midnightntwrk/wallet-sdk-dust-wallet` | `4.2.0` |
| `@midnightntwrk/wallet-sdk-capabilities` | `3.3.1` |
| `@midnight-ntwrk/ledger-v8` | `8.1.0` |

## Summary

`TransactingCapabilityImplementation.computeBalancingRecipe`
(`dist/v1/Transacting.js`) balances a DUST fee with an `Effect.iterate` loop
whose only exit is `converged: newFee <= recipeAmountCoverage` — the selected
coins covering the fee that selecting them produced. There is no iteration cap
and no progress check.

That loop has two independent defects, and the second makes the first
unrecoverable:

1. **Only the first pass can converge.** Pass 1 is seeded with
   `initialFees`, derived from `transaction.imbalances(0, totalFee)`, which for
   dust is **negative** (a deficit). Every later pass is seeded with
   `currentFee = newFee` from `dryRunFee(...)`, which is a **positive** fee. The
   balancer treats those as opposite requests.
2. **Smallest-first selection walks straight into it.** The default selector
   sorts ascending, so a wallet holding many part-drained dust coins spends a
   handful of them, which enlarges the transaction, which raises the fee above
   what those coins cover — landing in the dead zone created by (1).

The result is a loop that never exits and never fails. Each pass deserialises
and `eraseProofs()` a fresh WASM transaction on the calling thread, so the
process stops responding and its WASM heap grows until it is killed. Field
reports on affected wallets put that growth at roughly 16 MB/s until process
death; the traces in this report were produced with an analytic fee model, so
that figure is reported rather than measured here.

## Mechanism, precisely

With `transactionCostModel` both overheads `0n` and `targetImbalances` empty —
exactly what `computeBalancingRecipe` passes — `doBalance` in
`capabilities/dist/balancer/Balancer.js` reduces to:

```js
const shouldAddOutput = tokenType === counterOffer.feeTokenType &&
  imbalanceAmount >= 0n;   // getTargetImbalance() + outputFeeOverhead === 0n
```

So the sign of the seed decides the whole pass:

| Pass | Seeded with | Sign | Branch taken | Inputs selected |
|---|---|---|---|---|
| 1 | `imbalances(0, fee)['dust']` | negative | add inputs | as many as needed |
| 2+ | `dryRunFee(...)` | positive | **add an output** | **none** |

A pass that selects no inputs has coverage `0n`, so `newFee <= 0n` is false and
`converged` stays false. It also leaves no state for the next pass to differ
on: `currentFee` settles to `dryRunFee([])` and every subsequent pass is
byte-identical to the one before it. Nothing can break the cycle.

This is confirmed rather than inferred. `Transaction.imbalances(0, fee)` on a
freshly built intent returns the negative value:

```
$ node -e "…Transaction.fromParts('undeployed').addIntent(…).imbalances(0, 1430000000000000n)"
entries: [ [ 'dust', '-1430000000000000' ] ]
```

## Evidence — the iteration trace

Driving the **real** `getBalanceRecipe` and the **real** default selector
(`dust-wallet/dist/v1/CoinsAndBalances.js` `chooseCoin`, ascending) through the
same loop shape as `computeBalancingRecipe`, with `dryRunFee` replaced by
`fee(n) = 1.4e15 + 3.75e12 × n` — its one relevant property is that the fee
grows with the number of dust spends.

Wallet: 12 part-drained coins of `176250000000000` each, beside two near their
generation cap (`5e16`, `3e16`). Total dust `8.2e16`, far more than any fee.

```
=== SDK default (smallest-first) -> never-converged ===
  iter 1: feeIn=-1400000000000000 inputs=8 coverage=1410000000000000 newFee=1430000000000000 converged=false
  iter 2: feeIn=1430000000000000  inputs=0 coverage=0               newFee=1400000000000000 converged=false
  iter 3: feeIn=1400000000000000  inputs=0 coverage=0               newFee=1400000000000000 converged=false
  iter 4: feeIn=1400000000000000  inputs=0 coverage=0               newFee=1400000000000000 converged=false
  …identical forever…

=== largest-first -> converged ===
  iter 1: feeIn=-1400000000000000 inputs=1 coverage=50000000000000000 newFee=1403750000000000 converged=true
```

Pass 1 selects eight coins covering `1.41e15` against the `1.43e15` that
spending eight coins costs — short by `2e13`. Pass 2 selects nothing. Every
pass after it is identical. The wallet is not short of DUST: it holds 57× the
fee.

This trace is reproducible as a unit test, no devnet required:
`packages/core/tests/unit/sync/dust-coin-selection.test.ts` in
[`shieldedtech/moth-wallet`](https://github.com/shieldedtech/moth-wallet).

## Why smallest-first is the wrong default for DUST

DUST is not a UTXO set that fragments. A `QualifiedDustOutput` is bound to a
backing NIGHT UTXO, its spendable value is
`updatedValue(ctime, initialValue, genInfo, now, params)` — a meter that
regenerates toward `genInfo.value * nightDustRatio` — and a spend is
one-in-one-out: `DustLocalState.spend` nullifies the coin and mints a
`successorUtxo` with a reduced value and the next sequential nonce. Coin count
is pinned to the number of registered NIGHT UTXOs regardless of selection
order.

So a "small" dust coin is not a fragment awaiting consolidation; it is a
recently-drained coin that is refilling. Selecting those first has no upside
and two costs: it needs many coins to reach a fee, which inflates the
transaction and therefore the fee itself, and it is what puts pass 1 in the
position of under-covering. Largest-first needs one coin, produces the smaller
transaction, and rotates across backing UTXOs naturally as the drained ones
regenerate.

## What we are asking for

1. **A progress check in the loop.** A pass that selects **no inputs**, or one
   whose fee is **unchanged** from the previous pass, has no path to
   convergence and should fail with `InsufficientFundsError` rather than
   iterate. Either condition alone would have turned every occurrence of this
   into an immediate, correct, actionable error. An iteration cap would also
   bound the damage, but the two conditions above are exact — they are not a
   heuristic.
2. **Reconcile the seed's sign and units across passes.** Pass 1 is handed a
   signed imbalance and passes 2+ a positive fee. Whichever convention is
   intended, the loop should use one, so that later passes are capable of
   selecting inputs at all. As it stands passes 2+ are dead code that merely
   burns a WASM transaction each.
3. **Reconsider the default selector for the fee token.** Ascending order suits
   a token whose small coins are fragments worth consolidating. It does not suit
   one whose coins are regenerating meters bound to backing UTXOs, where the
   count is fixed and consuming many of them only enlarges the transaction.
   `chooseCoin` also compares with `Number(a.value - b.value)`; the sign of that
   cast is correct for the magnitudes involved, but DUST values exceed 2^53 and
   a bigint comparison would remove the question.

Items 1 and 2 are the fix. Item 3 is a default that stops most wallets from
reaching the defect, which is all a client can do from outside.

## What Moth changed on the client side in the meantime

`shieldedtech/moth-wallet` replaces the loop through the documented
`V1Builder.withTransacting` seam
(`packages/core/src/sync/dust-transacting.ts`). It keeps `dryRunFee` and
`calculateFee` and changes only the control flow — each pass covers the
outstanding deficit from coins not yet selected, then re-prices with everything
selected so far — so every non-converging pass strictly grows the input set and
the loop is bounded by the coin count. The same file can serve as the reference
implementation for asks 1 and 2 above; the loop itself is about forty lines.

With that loop, the SDK's own smallest-first selection converges on the wallet
above in two passes (pass 1 selects eight coins and under-covers; pass 2 adds
one more), and a wallet whose coins are *all* far below fee size converges too
— the case no selection order can rescue.

Moth also sets largest-first fee-coin selection
(`packages/core/src/sync/dust-coin-selection.ts`), which on its own converts
most affected wallets into the one-pass case but cannot fix the loop: a
uniformly tiny wallet still spins under any selection order when the loop is
the SDK's. That is why this report asks for the loop change and not the
default.
