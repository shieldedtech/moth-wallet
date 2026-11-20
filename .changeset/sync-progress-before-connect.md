---
'@shieldedtech/moth-wallet': patch
---

Make the overall sync percentage move with each sub-wallet, and stop it showing
99% before a sync has started.

The percentage is now the average of the sub-wallets still syncing, so it climbs
as shielded, unshielded and DUST each make progress; a sub-wallet that finished
with nothing to sync, such as an empty unshielded side, is left out. It used to
be the slowest sub-wallet alone, so a pre-seeded new wallet read 0% until DUST
finished and then 100%. The time estimate still comes from the slowest
sub-wallet.

Before the sub-wallets connect, each reads 0 of 0, and 0 of 0 was counted as
complete: a new wallet showed 99% with 0s remaining for its first seconds, then
fell to 0%, and because the 99% became the starting point for the time
estimate, no estimate appeared for the rest of the sync. A sub-wallet reading
0 of 0 now counts as complete only once it reports itself complete.
