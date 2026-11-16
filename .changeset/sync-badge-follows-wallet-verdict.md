---
'@shieldedtech/moth-extension': patch
---

Stop the top-bar badge saying "Synced" while the DUST wallet is still syncing.

The badge called itself synced when the three progress rows averaged to 100,
and 100, 100 and 99 average to 99.67, which rounds to 100. On a mainnet wallet
the top bar read "Synced" at DUST 99% while the DUST panel beneath still said
syncing, and the regression grace then held that "Synced" in place. The badge
now takes synced from the per-sub-wallet flags the rows and the DUST panel
already read, so the three cannot disagree.

The percentage beside the spinner is now the slowest sub-wallet rather than the
rows' average, matching the ETA shown next to it and the CLI's progress line: a
wallet at 100 / 75 / 25 reads 25%, not 67%.

A dropped indexer connection on a caught-up wallet still reads "Synced", as
before; it does not get a spinner. A distinct "not connected" state is a
follow-up.
