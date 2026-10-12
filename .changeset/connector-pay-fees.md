---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-extension': minor
---

Honour `payFees: false` on the dApp connector.

`makeTransfer`, `makeIntent`, `balanceSealedTransaction` and
`balanceUnsealedTransaction` used to reject `payFees: false` with
`InvalidRequest`. With it, the wallet now builds or balances without adding
DUST, leaving the network fee to another party. This lets a dApp or a
counterparty sponsor fees. Leaving the option out, or passing `true`, still
means the wallet pays. A non-boolean `payFees` is rejected.

This applies to the extension's dApp connector only. The daemon, CLI and TUI
have no connector, so their transactions still always pay their own fees.

In core, `buildTransferTransaction`, `buildSwapIntent` and
`balanceTransaction` each take a trailing `options` object, which is passed
on to the matching facade call. `buildTransferTransaction` takes
`{ ttl, payFees }`; this replaces its old trailing `ttlOverride` argument.
`buildSwapIntent` takes `{ payFees }`. `balanceTransaction` takes
`{ tokenKindsToBalance }`, and core now exports the `TokenKindsToBalance`
type. The balancing calls have no fee flag, so the extension asks for
shielded and unshielded tokens only when a dApp passes `payFees: false`. If
`dust` is left out and the transaction needs nothing else, the SDK throws "No
balancing transaction was created". In that case a sealed transaction is
returned unchanged and an unsealed one is only bound.

A transaction built this way cannot be submitted until someone adds the fee.
Pass it to `balanceSealedTransaction` with fees enabled, from this wallet or
another one.

The approval screen now says whether this wallet pays the network fee. When
it does not, the DUST shortfall is left off the "You pay" rows, because the
wallet will not cover it. The new copy stays in English in de/fr/es until
someone reviews the translations.

`makeIntent` now returns a sealed transaction (signed, proven and bound)
instead of the unproven output of `initSwap`. The connector API completes a
swap with `balanceSealedTransaction`, and Lace-compatible services reject the
unproven form with "expected header tag
'midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[v1]):'". In
core, `buildSwapIntent` now returns a `FinalizedTransaction`. Because the
intent is now proven, `makeIntent` needs the configured prover.
