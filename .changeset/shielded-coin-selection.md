---
'@shieldedtech/moth-wallet': minor
---

Choose which shielded coin a wallet spends first: `startWalletSync(..., { coinSelection })` takes `smallest-first` (the SDK's default, unchanged), `largest-first` or `best-fit` (the smallest coin that covers the payment on its own; in a swap, where the SDK does not pass the amount owed, it spends largest first). Spending the smallest coin first splits it on every payment smaller than it, so a wallet making many small payments ends up holding coins too small to pay with on their own; the other two rules spend from coins that can.
