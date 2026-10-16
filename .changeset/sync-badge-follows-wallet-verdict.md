---
'@shieldedtech/moth-extension': patch
---

Stop the top-bar badge saying "Synced" while the DUST wallet is still syncing.

The badge called itself synced when the three progress rows averaged to 100,
and 100, 100 and 99 average to 99.67, which rounds to 100. On a mainnet wallet
the top bar read "Synced" at DUST 99% while the DUST panel beneath — which
reads the wallet's own verdict — still said syncing, and the regression grace
then held that "Synced" in place. The badge now takes synced from the same
verdict the panel uses, and shows at most 99% beside a spinner.
