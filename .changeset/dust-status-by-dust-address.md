---
'@shieldedtech/moth-wallet': patch
---

Make `moth dust status` work, by keying it on the DUST address.

The command called `dustGenerationStatus(cardanoRewardAddresses)` with the
wallet's Midnight address — a placeholder left in the original implementation.
The indexer rejects that on the HRP before looking anything up, so the command
could never return a result for any wallet (#54).

It now asks the question that moth can actually key: `dustGenerations(dustAddress)`,
which takes the DUST address the wallet already derives, and reports entries,
decay updates, total value and the newest entry. Registration and capacity for a
cNIGHT holder stay unavailable — those genuinely need a Cardano stake address,
which moth does not derive.

The subscription is bounded by the generation tree's size read from the chain
(`Block.dustGenerationEndIndex` at the latest block, minus one, per the indexer's
schema), so it terminates with `complete` and an empty result is an answer rather
than a timeout. Two failure modes are handled explicitly: a rejected subscription
arrives as a `next` frame carrying `errors` rather than the protocol's `error`
type, and swallowing it is how a query that never ran reported "no DUST
generation"; and a run that stops on the time budget is reported as `truncated`
rather than presented as complete.
