---
"@shieldedtech/moth-wallet": patch
"@shieldedtech/moth-extension": patch
---

Keep every entry the timings log records in a burst. Each record read the stored list, appended and wrote it back, so records in flight at once overwrote each other: a transaction's proof jobs starting together showed only the last. Records now run one at a time in call order, each stamped with the time it was made.
