---
'@shieldedtech/moth-wallet': minor
---

Record a witness per cursor in exported references, and refuse a bundle without one.

A published reference records cursors that are indexer-assigned event sequence
numbers, so its correctness depends on an indexer that the bundle says nothing
about. That is how the preprod bundle stayed in use after the numbering underneath
it moved: the bytes were intact, the checksums matched, and the cursors had
quietly stopped naming the events they were written for.

`export-preseed.mjs` now reads the event at each cursor and records its hash in
the manifest under `witnesses`, alongside `height` and the per-part sizes. It
refuses to export at all if a cursor cannot be witnessed — including the case
where the indexer returns no event at or after the cursor, which means the
reference is *ahead* of the indexer it is being exported against and is itself the
renumbering signal.

The extension's installer requires them. A manifest without a witness for shielded
and dust is rejected, and the witnesses are written to the store before the height
— the height is what marks a reference usable, so a reference that reads as usable
without its witnesses is one that skips verification.

The asymmetry with local references is deliberate. A witnessless reference already
on disk is treated as unverifiable rather than invalid, because the alternative
forces every existing user into a chain walk on upgrade. A witnessless *bundle* is
an artefact we control and can re-cut, so refusing it costs one slower first sync
and trusting it costs a wallet silently resuming at the wrong event. The bundle
currently in the repository has no witnesses and will therefore no longer install;
a reference rebuilt from genesis against the current indexer replaces it.
