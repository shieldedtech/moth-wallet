---
'@shieldedtech/moth-wallet': minor
---

Refuse to submit a transaction to a network on a different ledger.

`ledgerVersionForProtocol` maps a network's reported `protocolVersion` to its
ledger generation (`1000000` is v8, `2000000` is v9), and
`assertLedgerForNetwork` / `verifyNetworkLedger` check the loaded ledger
against it. The daemon's `submitTransaction` now runs that check before
deserializing, so a mismatch fails with an error naming the network, both
ledger versions, and the fact that nothing was submitted.

Without this the failure is late and unreadable: collapsed Merkle updates are
shared across the fork, so a mismatched wallet syncs normally and only fails
at submission with a bare header-tag error.

Key derivation is unaffected — it produces byte-identical keys on both
ledgers, which is now pinned by a test.
