---
'@shieldedtech/moth-wallet': patch
---

Pay DUST fees from the largest coin first, so fee balancing terminates.

The wallet SDK's dust fee balancer (`wallet-sdk-dust-wallet` 4.2.0,
`computeBalancingRecipe`) loops until the coins it selected cover the fee that
selecting them produced, with no iteration cap and no progress check. Its
default selector takes the smallest coin first, so a wallet holding several
part-drained DUST coins spends a handful of them, which enlarges the
transaction, which raises the fee past what those coins cover — and the loop
never exits. It also never fails: only the first pass can converge, because
that pass is seeded with a negative dust imbalance while every later pass is
seeded with a positive fee, which sends the balancer down its add-an-output
branch and selects no inputs at all. Each pass deserialises and erases proofs
on a fresh WASM transaction while holding the thread, so the wallet stops
responding and its WASM heap grows until the process dies.

Moth now sets largest-first selection on the dust wallet through the SDK's
documented `V1Builder.withCoinSelection` extension point
(`sync/dust-coin-selection.ts`), on both the restore-from-cache and
start-from-secret-key paths. One coin near its generation cap covers a fee
outright, so the first pass converges — which is the only pass that can.

This costs nothing in DUST fragmentation: a dust spend is one-in-one-out (the
ledger nullifies the coin and mints a successor worth the remainder), coin
count is pinned to the number of registered NIGHT UTXOs, and a coin's value
regenerates toward its cap. Draining the fullest coin therefore rotates across
backing UTXOs on its own as the drained ones refill, and produces a smaller
transaction than spending eight coins to reach the same fee.

**This is a mitigation, not a fix.** A wallet whose dust is spread evenly
across coins that are all far below fee size still spins, because no single
coin covers the fee — pinned as a test, and filed upstream with the iteration
traces in `docs/upstream-issues/dust-fee-balancing-nontermination.md`, which
asks for the progress check that would close it. Transaction construction,
signing, and proving are unchanged.
