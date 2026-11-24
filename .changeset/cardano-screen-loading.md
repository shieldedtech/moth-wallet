---
"@shieldedtech/moth-extension": patch
"@shieldedtech/moth-wallet": patch
---

Cardano screen: on a visit with no kept status, show the account address at once, then ADA and cNIGHT balances from a quick read of the wallet's own UTXOs, then the DUST registration. The account list, derivation and status reads each give up after 2 minutes with a retry instead of a spinner that never stops, and a finished read no longer replaces a screen the user has moved on to. Renaming a Cardano account no longer re-reads the chain.

Registering cNIGHT now confirms with the receiving account's label and DUST address, matching the picker, which also lists DUST addresses rather than shielded ones and does not offer an account that has no DUST address yet.
