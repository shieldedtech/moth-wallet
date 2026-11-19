---
'@shieldedtech/moth-wallet': patch
---

Stop resending a transaction whose coins the wallet SDK has already released.

When the first send of a transaction provably never reached a block, the SDK
gives its coins and DUST back to the wallet. The submit retry still treated
some of those failures as transient — a node that accepts the connection but
does not answer RPC — and resent the same bytes five seconds later. A resend
that landed put a spend in flight while the wallet offered its coins to other
transactions, which then failed as double spends.

Such a failure is now reported at once, using the SDK's own classification;
sending again builds a fresh transaction. Resending is unchanged when the
outcome is uncertain, as with a socket that dropped mid-send, because the SDK
keeps the coins booked in that case.
