---
'@shieldedtech/moth-wallet': patch
---

Show real DUST progress while a projections sync pass is running.

A projections pass applies nothing to the wallet until it ends, so until its
first pass of a session landed the DUST wallet reported no total. The UI drew
that as DUST 0% beside an overall 99%, for a minute on every start and for the
whole spend walk after the ledger-v9 hand-over.

The pass now reports how far it has got, in blocks: the height the saved state
was synced to, then the block each nullifier lookup starts from. That figure is
shown until the wallet reports a total of its own, and it feeds the overall
percentage, so a wallet reopened near the tip reads 99% rather than 0% and a
walk in progress climbs as it goes.
