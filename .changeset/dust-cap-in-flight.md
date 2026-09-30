---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-browser': patch
'@shieldedtech/moth-extension': patch
---

Keep the DUST capacity steady while a submitted transaction lands.

The capacity was read off the dust sub-wallet's available coins. Submitting a
transaction moves the coin it spends out of that list at once, so the meter
fell to "of 0 · not registered yet"; when the spend landed, the old coin's
remainder kept its full cap while it decayed next to the fresh coin for the
change UTXO, so the meter doubled; and the dust and unshielded sub-wallets
apply the same transaction at different moments, so it settled only after
both had caught up.

The capacity is now derived from the registered NIGHT UTXOs, counting the
inputs booked by an in-flight transaction the way the NIGHT balance already
does, and dust coins whose backing NIGHT was spent no longer count toward it.
The arithmetic lives in `sync/dust-generation.ts`, which is unit-tested
without WASM.
