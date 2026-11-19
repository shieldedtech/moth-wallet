---
'@shieldedtech/moth-extension': patch
---

A dApp that connects and immediately asks the wallet for a transaction no longer
gets it rejected by the node.

`balanceSealedTransaction`, `balanceUnsealedTransaction`, `makeTransfer` and
`makeIntent` built their transactions without waiting for the wallet to finish
syncing. A midnight-js deploy straight after connecting could reach the wallet
in that window, and the node rejected its DUST spend as
`Malformed(InvalidDustSpendProof)`. All four now wait for the wallet to report
synced first.
