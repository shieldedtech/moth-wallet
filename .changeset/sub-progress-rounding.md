---
'@shieldedtech/moth-wallet': patch
---

Stop per-sub-wallet progress rounding up to 100%.

`subPct` rounded a part's fraction to the nearest percent, so 99.96% rendered as
`100%`. `overallSyncProgress` deliberately refuses to do that — *"never round up
to 100% while not synced: rendering a near-complete fraction as 100% is the
specific lie this function exists to remove"* — so the two contradicted each
other inside a single line:

```
syncing 99% (dust) — shielded 100%, unshielded 100%, dust 100%
```

The surfaces then showed a spinner beside a figure claiming completion: the
extension's DUST card read *Syncing DUST…* under `100%`, with the header badge
saying **Synced**. The spinner was right — `dustSynced` was genuinely false — and
the `100%` was the falsehood.

A part that is not complete now reports `99%+ (applied/total)`. The raw indices
are printed because at that point the percentage has stopped carrying
information, and what the reader needs is the size of the gap: a handful of
events behind a moving tip is a different situation from thousands.
