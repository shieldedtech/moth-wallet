---
'@shieldedtech/moth-extension': patch
---

Keep the Cardano screen on display when leaving Cardano accounts by the back arrow.

Without a Blockfrost project ID the Cardano screen cannot read balances, but
still offers the account switcher. The back arrow on Cardano accounts went
straight to the balances view, which had nothing to show, so the whole panel
went blank until the extension was reopened.

The back arrow now re-reads Cardano, as **Done** does, and returns to whichever
screen applies. If the balances view is ever reached without balances, it shows
the "cannot be read yet" notice with **Try again** instead of an empty panel.
Leaving the account list while **Switch** is still running no longer lets a
late reply put the previous account back in the account switcher.
