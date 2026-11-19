---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-tui': minor
'@shieldedtech/moth-extension': minor
---

Rebuild only the shielded part of a wallet's sync state.

A stale shielded view could only be repaired by clearing every part of the sync
cache, which also forces DUST to resync, by far the slowest part. That is the case,
for example, when an indexer renumbering leaves the stored shielded cursor pointing
at a different event ("values inserted non-linearly into zswap commitment tree"),
which retrying replays forever.

- Core adds `clearShieldedSyncCache`, which evicts the shielded state and keeps
  unshielded, DUST and history.
- The extension's Settings adds "Rebuild shielded coins", next to "Clear cache and
  resync". It spends nothing, so it needs no confirmation, and it waits while a
  transaction is in flight, as the DUST rebuild does.
- The TUI's wallets screen adds `s` (rebuild shielded) next to `c` (clear cache).
