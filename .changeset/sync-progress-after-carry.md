---
'@shieldedtech/moth-wallet': patch
---

Keep the sync percentage steady when a wallet update leaves out a sub-wallet.

An update from the wallet SDK can say nothing about one sub-wallet's progress:
the progress is absent, the balance read fails first, or it reads 0 of 0 while
connected. The last reading was carried forward only after the overall
percentage had been taken, so that update showed 99% (or 0%) and the time
estimate jumped with it. A DUST update reading 0 of 0 while connected also left
DUST marked synced for the rest of the session.

The last reading is now carried forward before the percentage is taken, and a
carried reading no longer counts as the sub-wallet finishing. A sub-wallet that
really finished stays marked finished.
