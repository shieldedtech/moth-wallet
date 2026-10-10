---
'@shieldedtech/moth-extension': patch
'@shieldedtech/moth-tui': patch
---

The Cardano screen shows the DUST generation rate in DUST per second.

The indexer reports the rate in SPECK per second (10^15 per DUST), and the
"Generating" row rendered that integer as-is, with no unit — 37204806800000000
next to a meter reading in DUST. It now goes through the same SPECK → DUST
conversion as the capacities and reads, for example, "37.204806 tDUST/s".
