---
'@shieldedtech/moth-wallet': patch
---

Stop the dedup filter from punching holes in a replay, and say what a non-linear
insert actually means.

`partitionByAppliedIndex` filtered the whole batch by predicate, dropping every
event with `id <= appliedIndex` wherever it sat. For an ascending batch that is
the intended boundary-duplicate filter. For an out-of-order one it removes an
already-applied event from the *middle* and hands the SDK a replay with a gap —
and the ledger tree then rejects the insert:

```
values inserted non-linearly into dust generation tree;
expected to insert index 337423, but received 337429.
```

Note the direction: the SDK bug this wrapper exists to work around re-sends a
boundary event, so the tree receives an index *lower* than it expects. This is
the mirror image — an index *higher* than expected, because events the tree
needed never arrived. The workaround for one could produce the other, and only
for the part whose cursor and tree had drifted apart, which is why a single
sub-wallet would stall while the others finished.

The filter now drops only a leading contiguous run of already-applied events.
When an already-applied id appears after a fresh one the batch is not the
ascending stream the filter assumes, so nothing is dropped and the SDK's own
(more conservative) handling decides. The existing test named "drops only the
already-applied prefix" described this behaviour already; the implementation now
matches it.

Non-linear insert failures are also no longer bare WASM strings surfacing four
layers down with no mention of sync state. They now carry the cursor and batch
that produced them and say that retrying cannot help — the same batch replays
from the same cursor forever — and that the fix is to clear that part's cache:

```
appliedIndex=1291234, replayed 2 event(s) 1291235..1291240,
0 dropped as already applied. Clear this wallet part's sync cache and resync.
```

The original error is preserved as `cause`. Unrelated errors pass through
untouched.
