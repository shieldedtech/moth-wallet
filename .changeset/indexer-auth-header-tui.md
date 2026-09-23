---
'@shieldedtech/moth-tui': patch
---

Honour `MOTH_INDEXER_HEADER` and a per-network `indexerAuthHeader` override in
the TUI settings, installing the header for the TUI's own indexer queries and
the sync engine alike. The environment variable wins over the settings file,
which is plaintext.
