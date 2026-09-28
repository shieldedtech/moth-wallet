---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-extension': patch
---

Show where a dApp transaction sends funds, and refuse to balance one the wallet cannot read.

`balanceSealedTransaction` / `balanceUnsealedTransaction` hand the wallet a
transaction a connected site built, and the wallet covers every deficit it
carries — so that approval screen is the only thing between a hostile site and
the wallet's funds. `balanceTransaction` applies no cap, no allowlist and no
destination check; the screen is the whole control.

It was showing amounts only. "You pay 3,000.000000 tNIGHT" reads identically
whether the tokens go to a contract the user meant to call or to an address
chosen by the site, so the one field that separates a legitimate transaction
from a drain was absent. The summary now carries every destination with what
each one receives, bech32m-encoded for the network, and the approval lists them
above the consequence note. Destinations belonging to the connected wallet are
marked, so its own change is not read as an outgoing payment.

Amounts are per destination rather than a single net total, because a total
cannot separate the two cases either: outputs of 2,999 to a third party and 1
back to the user render as one "You pay 3,000" beside two addresses, and the
wallet's own address carrying the *Your wallet* tag lends the decoy
legitimacy. Contract actions are listed as destinations too, and a payout with
no readable destination — a shielded output — says so in words rather than
leaving the note pointing at an empty list.

Addresses are shown in full. Middle-truncating them defeats the purpose: on
preprod and devnet the first fourteen characters are entirely the network
prefix, identical for every address on that network, so a truncated form leaves
the user comparing the tail alone.

The path also failed open. A summary that could not be produced was caught and
the request prompted anyway, with the screen saying the amounts were unknown —
turning the only control on this path into a warning a habituated user clicks
through. It now fails closed: the request is refused before any approval is
shown, and the reason the summary failed reaches the caller instead of a bare
`catch`, so a site (and a bug report) can say why. This costs nothing
legitimate, because the summary decodes with exactly the markers core's
balancing path uses — a transaction it cannot read is one balancing could not
have processed either. A summary that resolves but arrives malformed is refused
on the same grounds.

A transport failure is no longer reported to the site as `InvalidRequest`. The
host tags a decode failure, and everything else — the offscreen document not
starting, a messaging failure, a locked host — becomes `InternalError` with its
internal message withheld, so a site can tell "fix your transaction" from "retry
later".
