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
A failed read also clears the previous account's balances, so they are never
shown for another account.
