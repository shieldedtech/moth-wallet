---
"@shieldedtech/moth-extension": patch
---

Stop telling people to wait for tNIGHT they already hold, and always show the
DUST meter.

The meter's fallback text was "Waiting for tNIGHT" whenever generation capacity
was zero. Capacity is zero in two quite different situations: the wallet holds no
NIGHT, and the wallet holds NIGHT that has not been registered for generation.
Only the first is waiting for anything. The second is a wallet with capacity
available to it and an action to take, being told to sit still.

It now distinguishes them. No NIGHT reads "Waiting for tNIGHT"; NIGHT held but
unregistered reads "tNIGHT not registered yet"; registered NIGHT reports its ETA
as before. `DustView` also exposes `unregisteredNight`, so a caller can offer the
registration action rather than re-deriving the state.

The card is now shown whenever balances exist. It was previously hidden for a
wallet with no NIGHT and no tokens, which made the DUST mechanism look absent
rather than idle — and #101 had already carved out an exception for holding DUST
without NIGHT. Two exceptions to a rule is a sign the rule was wrong: the card
says which state it is in, so the panel does not need to decide by omission.

This supersedes #101's "hide the meter when there is no DUST either", and that
test is updated rather than deleted so the change of intent is visible.
