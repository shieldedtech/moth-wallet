---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-cli': patch
---

Stop retrying a sync cache the ledger has already refused, and say why.

`moth preseed refresh -n preprod` failed reproducibly after importing the
reference shipped in `packages/extension/public/preseed/preprod`:

```
Wallet.Other: Error while applying sync update
  [cause]: values inserted non-linearly into dust commitment tree;
           expected to insert index 1059933, but received 1059955
```

Neither the resume arithmetic nor the units were at fault, and the bundle's bytes
decompress faithfully. That bundle is internally inconsistent: its dust snapshot
records `offset` 1431375 — an event id — while its commitment tree holds 1059933
entries, which is the state as of event **1431353**. Confirmed against the live
preprod indexer: event 1431375 does carry commitment 1059954 and event 1431376
carries 1059955, and replaying 1431354…1431376 onto the shipped state succeeds
and takes the tree to 1059956. So the snapshot is 22 events short of the cursor
it advertises, and everything that resumes from that cursor skips those 22
events. `DustLocalState.serialize`/`deserialize` round-trips the tree position
faithfully, so the drift was baked into the artifact when it was built, not
introduced when it is read.

Such a snapshot cannot be repaired in place. The ledger accepts exactly the next
index, so the resume point has to be exact: a rewind re-delivers events the tree
already holds and fails the same way, and nothing local can map a tree position
back to the event id that produced it. Discarding the state and syncing that part
from genesis is the only correct move — the "fail closed to a genesis sync" ADR
0003 asks for — and the ledger's own linearity check is what catches it, so that
check stays exactly as it is.

What was wrong was everything after the throw. The error was opaque (a WASM
message about tree indices, for what is really "this cache is unusable"), the SDK
retried the same impossible position with no ceiling, the reference stayed on disk
and kept being advertised as ready, and `preseed refresh` sat out its full
two-hour budget on a stream that could not apply a single event.

Now:

- `sdk-dedup.ts` classifies the failure it is already in the stack for. A
  non-linear insert on a batch that starts exactly one past `appliedIndex` proves
  the *state* is short and raises `InconsistentCachedStateError`; one on a gapped
  batch means events went missing in transit, so the original error is rethrown
  untouched and the SDK's retry heals it. Evicting a healthy cache there would
  trade a self-correcting hiccup for a full re-sync.
- `startWalletSync` treats it exactly like the corrupt-cache case it already
  handles: evict that part, say so, and let the next start rebuild it from
  genesis. Reported once, not once per retry. `saveCache` no longer writes an
  evicted part back — the in-memory state is the same short snapshot, so the
  60-second timer or `stop()` would have quietly undone the eviction.
- A reference build stops when its own state turns out to be un-advanceable,
  instead of waiting out `REF_BUILD_TIMEOUT_MS`, and names what has to happen
  next (build a fresh reference; the rebuild walks the chain).
- `moth preseed refresh` exits non-zero when it could not advance the reference.
  It previously reported success on that path, printing `heightAfter: null` and an
  `advancedBlocks` of minus the entire chain.

The shipped preprod bundle is still inconsistent — nothing here fixes those bytes,
and re-cutting the reference is a separate job.
