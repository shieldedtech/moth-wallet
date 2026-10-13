---
'@shieldedtech/moth-extension': patch
---

Make dApp approvals and auto-lock say and do what they claim.

- The connect screen no longer says a site cannot see your balances or history. A connected site reads balances, addresses and transaction history without asking, so the screen now lists that under what it can do, and the transfer note no longer claims the site never sees your balances (#203).
- A connected dApp can no longer keep the wallet unlocked indefinitely (#204). Its requests still extend the session, so a dApp in use does not lock mid-session, but only up to four auto-lock windows without the user touching the panel or answering an approval. A pending approval no longer blocks the lock: when the window expires, it is rejected and the wallet locks. Showing an approval counts as dApp activity, so the user gets a full window to decide, and an approval answered as the window expires is never locked out from under.
- The `makeIntent` approval shows the inputs the wallet contributes as what you send, and lists the outputs as paid out with their recipients. It previously showed only the outputs, under "You send" (#206).
