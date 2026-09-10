---
'@shieldedtech/moth-extension': patch
---

Stop reporting a wallet's real DUST as "0% of 0, tNIGHT not registered yet".

A wallet's DUST balance and its generation cap come from different places: the
balance is applied dust events, the cap is generation records. When the records
are missing locally but the balance is not, the DUST screen showed all three of
these at once — a real balance, a cap of zero, and a claim the NIGHT was not
registered — on the same card whose detail view said "Registered — generating"
two rows above.

The cause was ordering. `etaText` started at "not registered yet" whenever the
wallet held NIGHT, and every branch that could correct it was gated on a
non-zero cap. A registered wallet with no cap therefore kept the one statement
known to be false. The chain is now ordered so the fallback is reached only when
nothing better applies, and the "not registered" copy is used only when the
wallet genuinely has not registered.

A cap of zero on a registered wallet holding value is now reported as unknown
rather than zero. The meter drops the meaningless "of 0" and the "0% generated"
caption, saying the capacity is unknown and the generation records are missing —
which is also the condition the rebuild button exists to fix.

The rebuild note no longer promises "several minutes". A rebuild clears the dust
cache and resyncs; whether that re-seeds from the local reference or walks the
chain from genesis depends on the wallet's birthday, and the genesis walk is
~1.4M events. It now says up to an hour, which is the case a user actually needs
warning about.
