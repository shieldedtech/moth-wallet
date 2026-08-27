---
'@shieldedtech/moth-wallet': minor
---

Add a ledger version to network configuration, and a stagenet preset.

`NetworkConfig` gains two optional fields: `ledgerVersion` (`'v8' | 'v9'`,
defaulting to `v8` via `resolveLedgerVersion`, so existing configurations are
unchanged) and `faucetUrl`, which `validateNetworkConfig` now scheme-checks like
the other endpoints.

`stagenet` joins `DEFAULT_NETWORKS` and `SUPPORTED_NETWORKS`, carrying all three
of its services — node, indexer and faucet — and marked as a v9 network. It is
the first stack Moth targets on ledger v9. See ADR-0006.
