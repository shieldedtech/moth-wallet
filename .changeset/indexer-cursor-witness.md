---
'@shieldedtech/moth-wallet': minor
---

Detect an indexer renumbering instead of silently syncing from the wrong place.

Sync cursors are indexer-assigned event sequence numbers, and nothing ties an id
to a block — `DustLedgerEvent` carries only `id`, `raw`, `maxId` and
`protocolVersion`. So when the same URL starts serving a differently-numbered
stream, a stored cursor names a different event and the sync resumes at the wrong
point without erroring. The only guard was a string comparison of `indexerUrl`,
which by definition cannot see a backend swap behind an unchanged name — and it
lived in the extension's background, so the CLI and TUI had no check at all.

This has already happened on preprod. The default indexer had a 22-wide hole in
its dust id space; the host now serving that name numbers contiguously, so cursors
written before the change sit 22 events too high. The pre-seed reference committed
for the extension stores dust cursor `1431375`, which under the current numbering
is 22 events beyond the state the snapshot holds — verified against the live
indexer, where that id now yields digest `3f3576deb45ad350` while the event the
reference actually stopped at yields `11c8cf9fd5a736f2`.

A cursor is now stored with a **witness**: the hash of the event found at that id.
On resume the id is re-read and compared. Same event means the numbering is
unchanged; a different event means it moved and the cursor is refused, failing
closed to a genesis sync — the direction ADR-0003 already establishes as always
safe.

A witness rather than one global indexer fingerprint, because a fingerprint has to
be sampled at a fixed id and any id below the point where two numberings diverge
returns the *same* event from both. Sampled at preprod's hole (989781), old and
new both return the event new calls 989781 — old's first existing id at or above
that probe was 989803, the same event — so a fingerprint there would have matched
across the exact cutover it existed to detect. The divergence point is not
knowable in advance; a witness has no such blind spot, because it asks only about
the id the cache actually depends on.

Three paths are gated: the warm read verifies before handing a reference to any
wallet, a build records witnesses for the cursors it stops at, and
`refreshEmptyRefCache` refuses to resume across a mismatch — resuming would carry
the old numbering forward into a reference that then looks freshly built, which
destroys the evidence.

Scope. Only shielded and dust are witnessed: they ride the global ledger-event
numbering and are the two the preprod change moved, where unshielded is keyed by
address. Per-wallet caches are not yet gated — normal sync persistence is written
by the SDK's own serialization rather than through `saveCachedState`, so covering
those needs a separate seam. A reference with no witness is treated as
unverifiable rather than invalid, so upgrading does not force a chain walk on
everyone at once; new references carry witnesses and the population converges.
