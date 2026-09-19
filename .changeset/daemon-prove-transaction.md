---
'@shieldedtech/moth-wallet': minor
---

Add a `proveTransaction` daemon verb, and honour `MOTH_HOME`.

`proveTransaction` builds, balances, proves and signs a transfer, then returns
the finalized transaction as hex instead of submitting it. Programmatic clients
that need to hold a proof and submit it later had no verb for the prove half;
`submitTransaction` already covered the other. The returned hex binds fee-side
DUST UTXOs by nullifier, so the wallet must stay quiet until submission — the
L3 modal says so, and `--max-spend` applies as it does to `transferTokens`.

`MOTH_HOME` now overrides the `~/.moth` root for both the filesystem storage
adapter and the daemon socket path, so several isolated instances can run from
one account. A relative value is rejected rather than resolved against the
working directory, which would otherwise put a wallet and its socket under
different roots.
