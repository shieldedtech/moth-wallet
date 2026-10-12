---
'@shieldedtech/moth-extension': patch
---

A DUST balance whose generation records have not been applied locally now
reports its capacity as **unknown** rather than as zero, so a wallet holding
real DUST no longer reads "3,301.04 of 0" at "0% generated" beside a detail
screen saying it is registered and generating. While the records are still
settling — the normal window after registering — the wallet says so instead of
reporting them missing. Rebuilding the records now says it can take up to an
hour, which is the honest figure for a wallet that has to walk the chain.
