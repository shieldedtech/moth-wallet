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
from a drain was absent. The summary now carries every unshielded destination,
bech32m-encoded for the network, and the approval lists them above the
consequence note. Destinations belonging to the connected wallet are marked, so
its own change is not read as an outgoing payment.

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
