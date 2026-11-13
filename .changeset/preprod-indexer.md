---
'@shieldedtech/moth-wallet': patch
---

Preprod now uses `indexer.preprod.shielded.tools` as its default indexer.
`indexer.preprod.midnight.network` was decommissioned on 2026-10-09 and answers
every request with HTTP 410, so the extension, CLI and TUI could not sync
preprod on their default settings. Wallets with custom endpoints keep them.

`moth preseed build` no longer hangs when it starts from nothing. The reference
wallet it syncs tried to pre-seed itself from the reference it was in the middle
of building, waited on that build forever, and the command exited 0 having
built nothing. Refreshing an existing reference was not affected.
