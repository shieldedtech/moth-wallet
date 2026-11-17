---
'@shieldedtech/moth-extension': patch
---

The extension installs a bundled pre-seed reference whose DUST was synced from
projections. From the v9 fork on, a DUST snapshot's offset is a block height, not
an event id, so there is nothing to witness and the export records no DUST
witness. The extension used to require one, so it would have refused every such
bundle and new wallets would have synced from genesis. A DUST snapshot that
replayed events still has to arrive witnessed, and the shielded witness is still
required.

`scripts/export-preseed.mjs` follows the same rule: it no longer tries to read a
projections DUST offset as an event id, which made it refuse to export.
