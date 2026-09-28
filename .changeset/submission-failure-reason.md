---
'@shieldedtech/moth-wallet': patch
---

Surface what the network actually said when a submission fails, instead of the
wallet SDK's placeholder.

Every submission failure reached Moth as the constant string `Transaction
submission error`. The wallet SDK reports a node's verdict through two nested
Effect `Data.TaggedError`s whose own messages are fixed
(`wallet-sdk-capabilities/submission` wraps `wallet-sdk-node-client`, which
wraps the polkadot RPC error), so the only member of the chain that says
anything — the node's `1010: Invalid Transaction: Custom error: 170`, or the
relay's `Could not connect within specified time range (5s)` — sat two `cause`
levels below the message every surface renders.

Three consequences, all of them from the same one-line habit of reading
`error.message`:

- A user was told only that submission failed. The extension's failure screen
  then blamed proving in its footnote, which is the one stage that had
  demonstrably succeeded.
- `isAlreadyImported` never saw a 1013, so a resubmission of bytes the pool
  already held was reported as a failure rather than as the success it is.
- `isTransient` never saw a dropped connection, so a transaction the relay
  never delivered was treated as the node's final answer and the one retry
  that would have landed it was skipped. `isTransient` also did not recognise
  the SDK's own wording for a relay that never came up at all (`Could not
  connect within specified time range (5s)`), which is now matched.
- `isDustSpendProofRejection` never saw a `Custom error: 170`, which made the
  wedged-dust-ledger detector (`sync/dust-ledger-health.ts`, backing
  `docs/upstream-issues/dust-ledger-wedge-invalid-dust-spend-proof.md`)
  unreachable on the path it is wired into — the streak it needs could never
  advance past zero, however many times a chain wedged.

`types/errors.ts` gains `errorChainMessages` / `errorChainMessage`, which walk
`cause` and Effect's `failure` and return the chain's distinct messages, and
`TransactionSubmissionError`, which restates a failed submission with that
chain as its message and keeps the original on `cause`. Every classifier on
the submission path now matches against the chain, and the tests that cover
them reject with the SDK's real nesting rather than a flat `Error` — the shape
that let all four cases pass while none of them worked.

No change to how any transaction is built, signed, proven or submitted.
