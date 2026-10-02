---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-cli': patch
'@shieldedtech/moth-tui': patch
---

`MOTH_HOME` now applies to everything moth writes to disk.

It moved the keystore and the daemon socket but not the sync cache, daemon API
keys, the daemon audit log or contract private state (`level-db`), which each
built `~/.moth` themselves. A process that sets `MOTH_HOME` to isolate itself
was still sharing those with every other instance on the account, and deleting
a wallet looked for its socket under the wrong root.

**If you already set `MOTH_HOME`:** those four now resolve under it. Existing
API keys, audit log, sync cache and contract private state stay in `~/.moth`
and are not migrated. Move them across, or reissue API keys, after upgrading.
Without `MOTH_HOME` nothing changes.
