---
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-wallet': minor
---

Show what a dApp transaction takes from the wallet before the user approves it.

When a connected dApp calls `balanceSealedTransaction` or
`balanceUnsealedTransaction`, the wallet is asked to cover whatever the dApp's
transaction is short of — and the approval screen said only "Network fee: paid
in DUST". The user was approving a spend without being told the amount or the
token. The screen now lists, per token, what the wallet has to supply ("You
pay") and any surplus it collects back ("You get back"), plus the number of
contract calls when there are any. If the transaction cannot be decoded, it
says so in a visible warning rather than showing nothing.

The amounts come from the transaction itself, before anything is balanced,
booked or spent: core gains `summarizeTransaction` /
`summarizeConnectorTransaction` (`sync/tx-summary.ts`), which sums the ledger's
`Transaction.imbalances(segment)` over the guaranteed section and every intent.
A negative imbalance is what the wallet must put in; a positive one is change.
The sign convention is pinned by a test against the real ledger. Fees are not
included — they are only known once the wallet has balanced and proven its own
segment, and are always paid in DUST.
