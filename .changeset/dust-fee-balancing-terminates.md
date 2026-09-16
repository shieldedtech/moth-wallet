---
'@shieldedtech/moth-wallet': patch
---

Replace the wallet SDK's DUST fee-balancing loop with one that terminates.

The SDK's `computeBalancingRecipe` (`wallet-sdk-dust-wallet` 4.2.0) re-selects
dust coins until they cover the fee of the transaction they produce, with no
iteration cap and no progress check. It also seeds its first pass with a
negative dust imbalance and every later pass with a positive fee; the balancer
reads the positive seed as a surplus, adds an output and selects nothing, so
only the first pass can ever converge. A wallet holding several part-drained
dust coins under-covers on that first pass and the loop then spins forever,
building and proof-erasing a WASM transaction on the calling thread each time
until the process runs out of memory.

Moth now supplies its own transacting capability through the SDK's documented
`V1Builder.withTransacting` seam (`sync/dust-transacting.ts`). It keeps the
SDK's fee arithmetic — `dryRunFee` and `calculateFee`, the WASM parts — and
replaces only the control flow: each pass covers the outstanding deficit from
coins not yet selected, then re-prices the transaction with everything selected
so far. A pass that does not converge has strictly grown the input set, so the
loop is bounded by the number of coins; running out surfaces as the SDK's own
`InsufficientFundsError`. Both `estimateFee` and `balanceTransactions` route
through the replaced method, so the fee preview and the real spend take the
same path. Coin selection order is unchanged.

Trade-off: this couples Moth to the SDK's exported implementation class and
three of its methods. The test suite pins that surface so an SDK upgrade that
changes it fails in CI rather than silently reverting to the non-terminating
loop. `effect` becomes a direct dependency of `@shieldedtech/moth-wallet` (it
was already in the tree via the SDK) because the capability returns the SDK's
`Either` values. The same loop is proposed upstream in
`docs/upstream-issues/dust-fee-balancing-nontermination.md`.
