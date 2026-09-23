---
'@shieldedtech/moth-cli': minor
---

`MOTH_INDEXER_HEADER="Name: value"` (or `--indexer-header`) sends an
operator-issued header on every indexer request, for indexers whose edge
rate-limits by source address. It applies to the daemon, every command that
syncs, and the commands that query the indexer directly. It is read from the
environment or the flag only — never from `moth config`, since `~/.moth` is
plaintext and the value is a credential. Prefer the environment variable: a
flag is visible in the process list.
