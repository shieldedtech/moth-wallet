---
'@shieldedtech/moth-extension': patch
---

A dApp that connects and immediately asks the wallet to balance a transaction
no longer gets it rejected by the node.

`balanceSealedTransaction` and `balanceUnsealedTransaction` balanced without
waiting for the wallet to finish syncing. A midnight-js deploy straight after
connecting could reach the wallet in that window, and the node rejected its DUST
spend as `Malformed(InvalidDustSpendProof)`. Balancing now waits for the wallet
to report synced, as transfers already did.
