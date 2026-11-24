---
'@shieldedtech/moth-extension': patch
---

Show the last Cardano status straight away and refresh it in the background.

The Cardano screen kept its status only while it was open, so every visit,
**Try again**, **Done** and account switch read the chain again from scratch,
and a read left behind by a closed screen kept running. The background now
keeps the last status for each account until the wallet locks, and runs one
read at a time per account. The screen shows the kept status at once with
"Updating from Cardano…", and says so if the update fails.

A transaction from the Cardano screen clears the kept status, so the screen
never shows the state from before it. A slow read for an account you have
since switched away from no longer overwrites the current one.
