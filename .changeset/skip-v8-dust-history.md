---
'@shieldedtech/moth-wallet': patch
---

A wallet syncing from scratch now starts its DUST at the ledger-v9 fork instead
of replaying the ledger-v8 DUST history (the SDK's `skipLedgerV8DustHistory`).
On preprod a funded wallet's first sync drops from 29 minutes to under 4, and
ends in the same state: the same balances, DUST UTXO, registration and
generation. Networks restarted DUST at that fork, so no earlier DUST survives
it. A wallet restored from its recovery phrase no longer lists the DUST side of
transactions from before the fork, which is mostly the fee rows of old contract
calls; its shielded and unshielded history is unchanged. Wallets that already
have a synced state are unaffected.
