---
'@shieldedtech/moth-wallet': patch
---

Check a new wallet's DUST history with the query indexer 4.4 accepts, so it can be
pre-seeded again instead of syncing DUST from genesis.

Indexer 4.4 replaced the `dustGenerations(dustAddress, startIndex, endIndex)`
subscription with `dustGenerations(dustAddress, blockHash, dtimeCutoffHeight)`, and
serves it only at a recent block. Every check on such an indexer was rejected, so
every new wallet without a usable birthday synced DUST from genesis.

The check now subscribes at the tip and counts only the owned entries whose index is
below the generation tree's size at the reference height. The tree only appends, so
those are exactly the entries that existed then. An indexer that refuses that form
(4.3) is asked with the index range as before.
