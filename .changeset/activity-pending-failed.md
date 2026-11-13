---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-browser': patch
'@shieldedtech/moth-extension': patch
---

Show a submitted transaction in the activity feed straight away, wallet sends
and dApp connector transactions alike, and mark it failed when the node rejects
it, the wallet SDK rules it out, or its deadline passes unseen. Home always
shows the Recent activity section with its "See all" link, and a failed feed
read is retried. Core gains `onTransactionOutcome` on `startWalletSync`,
`submitFinalizedTransactionWithReceipt` and `rejectedTransactionHash`.
