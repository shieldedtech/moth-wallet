---
'@shieldedtech/moth-wallet': patch
---

Show what a transfer can actually spend.

A synced wallet reported 500 NIGHT and refused a 10 NIGHT transfer with
`Insufficient funds`. Both figures were true and neither was reconcilable from
outside the wallet.

The displayed balance counts coins reserved by transactions in flight, and does
so deliberately — dropping them flashes the balance to zero mid-send. But the SDK
spends from `availableUtxos` alone, so the number shown was never the number that
could be spent, and nothing surfaced the difference.

`moth balance` now prints the split when anything is reserved, and stays quiet
otherwise:

```
NIGHT:
  unshielded: 500.000000  (500000000 STARS)
    available:  0.000000  ← what a transfer can use
    reserved:   500.000000  (a transaction in flight holds these)
```

JSON gains `unshieldedAvailable` and `unshieldedReserved` beside the existing
fields, so nothing reading it today breaks. The transfer's insufficient-funds
path names the number that blocked it, and says nothing when a reservation was
not the cause.

Nothing new is computed — `WalletBalances.coins` already carried the split.

This makes the state visible; it does not stop reservations outliving their
transactions. A wallet already in that state still needs its sync cache cleared.
