---
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-wallet': minor
---

Settings → Network shows where the account's wallets stand on the protocol version line, as the
wallet SDK reports it: the version transactions are built for, the ledger it puts the wallet on
(ledger-v8 below the v9 fork, ledger-v9 from it) and whether the three wallets have settled on it
or are still crossing a fork. Core exposes it as `protocolStatus(facade)`.
