---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-extension': patch
---

Combine retained, collapsed references with DUST-only recovery for restored or
older wallets. When no birthday-compatible reference exists, the extension offers
a witnessed candidate to core's DUST-history check without changing wallet
assignments, seeding other parts, or enabling imported-wallet contributions.

Treat malformed history responses, unknown event types, incorrect subscription
IDs and invalid tree sizes as unknown history instead of evidence that no DUST
history exists.
