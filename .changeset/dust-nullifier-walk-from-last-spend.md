---
'@shieldedtech/moth-wallet': patch
---

Stop the first DUST sync after the ledger-v9 hand-over taking a minute per DUST
spend the wallet has ever made.

A projections pass follows each coin's spend chain one lookup at a time, and the
SDK started every lookup at block zero: on mainnet that is about 22 MB and a
minute each. The pass applies nothing until it ends, so a wallet with a spending
history sat at "Syncing DUST…" with no progress for as long as the whole walk
took, and started over if it was interrupted.

Each lookup after the first now starts at the block the previous one matched,
since a coin cannot be spent before the block that created it. The walk covers
the chain roughly once instead of once per spend.
