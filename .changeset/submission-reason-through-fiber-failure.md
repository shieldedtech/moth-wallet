---
'@shieldedtech/moth-wallet': patch
---

Show the network's reason for a refused submission again.

A send the node refused reached the failure screen, the CLI and the daemon as
the bare "Transaction submission error", with no reason. The wallet SDK runs its
submission with `Effect.runPromise`, which rejects with a FiberFailure: its
message is the SDK's placeholder, and the error it wraps — whose `cause` chain
ends in the node's verdict, such as `1010: Invalid Transaction` — sits behind a
symbol key with no `cause` property. The cause walk that every reason, retry
decision and the wedged-dust-ledger detector depend on stopped at that wrapper.

The walk now opens a FiberFailure through Effect's own API and continues from
the wrapped failure or defect, so the message carries the network's words and a
dropped connection is told apart from a rejection again.
