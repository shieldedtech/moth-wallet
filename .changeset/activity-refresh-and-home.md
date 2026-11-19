---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-extension': patch
---

Show a submitted transaction in the activity feed straight away, and its failure when it is rejected.

The feed only re-read itself when sync applied something, so a pending or rejected
transaction stayed out of view until an unrelated one landed. It now re-reads when
either is recorded, keeps the amount and recipient on the row, and dates it, for
transactions a dApp submits as well. Home always shows Recent activity with "See
all", and a failed read of the feed is retried. Deregistering from DUST generation
now shows "proving" while its proof is made.
