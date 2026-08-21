---
'@shieldedtech/moth-wallet': minor
---

Discover a birthday from the chain, and refuse one the chain contradicts.

Asking a user for a date was the weakest part of asserting a birthday: they had
to remember, and a date guessed too late hides funds silently. The indexer
indexes unshielded transactions by address, so the first one can simply be looked
up — one round trip, no chain walk. Verified against preprod: an address with
history answers in well under a second, and an unused address is identified by a
`highestTransactionId` of 0 in ~0.5s.

`wallet import --birthday-discover` takes that height. All four ways of asserting
a birthday are also now checked against it: if the indexer holds a transaction
*below* the asserted birthday, the assertion is provably false and the import is
refused, naming the height it found. `--birthday-force` overrides. An unreachable
indexer warns that the check did not run rather than blocking the import, so a
skipped check is never mistaken for a passed one.

The rules live in core (`resolveBirthdayClaim`, `firstUnshieldedActivity`) and all
three surfaces call them, so they cannot drift: the CLI gains the two flags, the
TUI onboarding step gains "Look it up for me", and the extension's setup step
gains the same option — resolved in the offscreen host, since deriving an address
from the seed is not something the service worker may load.

What none of this covers is shielded history, and the docs now say so plainly.
Shielded coins are found by trial-decrypting outputs with a viewing key: there is
no address to index, so no query can rule out an earlier shielded receive. A
discovered birthday is therefore correct for unshielded and unverified for
shielded — and if shielded funds arrived before it, the sync starts above them
and the balance simply looks smaller, with nothing reporting an error. Clearing
the account's sync cache rescans and recovers them. Every surface states this at
the point of choosing, not only in documentation.
