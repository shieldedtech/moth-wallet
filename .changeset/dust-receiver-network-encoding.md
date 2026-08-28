---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-cli': patch
---

Derive the DUST receiver for the network being registered on.

`designateForDust` left the receiver undefined when the caller did not name one,
which let the SDK derive "my own DUST address" itself — for whichever network the
wallet was created against, not the one the registration is for. A wallet created
on devnet and registered on preview therefore sent preview's node a
devnet-encoded receiver, and the node refused it.

The refusal arrives as `Transaction submission error` with nothing else: the
reason lives several levels inside an Effect failure, and every layer above
rendered only the top-level message. Six identical failures over eighteen minutes
looked like a network fault, a protocol mismatch, or the documented self-funding
delay — it was none of those. Passing the preview-encoded receiver explicitly
succeeded on the first attempt.

The receiver is now derived from the keys in hand and the network in the request,
falling through to the previous behaviour if it cannot be encoded. This is the
same root cause as the wrong-network address in `wallet list` and `dust status`,
reaching transaction construction rather than a query — where the cost is a
rejected transaction instead of a wrong string.

Also surfaces error causes CLI-wide. `BaseCommand.catch` rendered `err.message`
and discarded `err.cause`, so any wrapped SDK failure printed as its least
informative line. It now walks the cause chain and appends what it finds, which
turned the next failure in the same session from `Deploy failed` into
`Deploy failed: Invalid response body ... Premature close`. `MOTH_DEBUG_ERRORS=1`
dumps the raw error for cases the chain does not reach.
