---
'@shieldedtech/moth-extension': patch
---

Send waits for a previous transaction to confirm instead of failing.

A transaction books the coins it spends, including a whole DUST coin for its
fee, until the wallet sees it confirmed. Once every coin is booked, the next
send cannot be built until an earlier transaction confirms and returns its
change. The fee estimate failed in that state, and the screen said "You can
still send", but sending failed the same way.

The send screen now recognises this case. It shows "Waiting for previous
transaction", holds the Send button, and re-checks every few seconds. When the
coins come back, the fee appears and Send is enabled. An estimate that fails
with nothing in flight still shows "Unavailable right now" and lets the user
send, as before.
