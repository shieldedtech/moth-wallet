---
'@shieldedtech/moth-wallet': patch
---

Release coins booked by a failed transaction after a restart, not only within a
session.

Sending or balancing a transaction books its input coins as pending. The wallet
SDK releases them once the indexer reports the transaction failed, partly failed
(a contract call whose fallible part rolled back, so only the fee was paid) or
expired. It kept that list in memory, while the booked coins were saved with the
sync cache. A session that stopped before the result landed, such as a one-shot
CLI command, an extension lock or a daemon restart, left those coins pending for
good. A shielded balance showed short, and an unshielded coin couldn't be spent
until the cache was cleared and resynced.

The list of watched transactions is now saved with the rest of the sync cache.
On restart it goes back to the SDK, which re-checks each transaction and
releases what failed. `clearSyncCache` removes it too.
