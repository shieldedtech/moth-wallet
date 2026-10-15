---
'@shieldedtech/moth-wallet': patch
---

Sync progress is logged each time the whole percentage changes, as intended.

The comparison ran against the value it had just overwritten, so it was always
false: progress lines appeared only for the first three updates, every 50th,
and on completion.
