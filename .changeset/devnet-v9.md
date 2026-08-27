---
'@shieldedtech/moth-wallet': patch
---

Mark devnet as a ledger v9 network.

Its indexer reports `protocolVersion 2000000` and its transactions are tagged
`transaction[v12]`, which only ledger v9 accepts. Moth was loading the v8 stack
for devnet, so any devnet transaction failed on a header-tag mismatch.
