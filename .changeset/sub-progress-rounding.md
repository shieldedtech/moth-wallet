---
'@shieldedtech/moth-wallet': patch
---

Stop per-sub-wallet progress rounding up to 100%.

Each part's fraction was rounded to the nearest percent, so 99.96% rendered as
`100%`. `overallSyncProgress` deliberately refuses to do that — *"never round up
to 100% while not synced: rendering a near-complete fraction as 100% is the
specific lie this function exists to remove"* — so the two contradicted each
other inside a single line:

```
syncing 99% (dust) — shielded 100%, unshielded 100%, dust 100%
```

A part that is not complete now reports `99%+ (applied/total)`. The raw indices
are printed because at that point the percentage has stopped carrying
information, and what the reader needs is the size of the gap: a handful of
events behind a moving tip is a different situation from thousands. With the
real numbers visible, the same wallet turned out to be 6,401 events short and
frozen, which the rounded `100%` had been hiding:

```
syncing 99% (dust) — shielded 100%, unshielded 99%+ (567046/567016), dust 99%+ (1447298/1453699)
```

The clamp and the format now live in `sync/progress.ts`, the WASM-free home for
this arithmetic, and are exported. Two surfaces carried separate copies and had
drifted: the core log line, and the extension's popover rows
(`lib/ui/sync-view.ts`), whose rounded figures the header badge averages into
its Synced verdict — so the extension showed `100%` rows and a **Synced** badge
beside a spinner that was correctly still syncing. Both now call the same
export, so they cannot disagree again. The TUI already floored and printed raw
counts, and the CLI reads the already-clamped overall figure; neither changes.

Two deliberate behavior changes fall out of sharing one implementation:

- A sub-wallet with nothing to apply (`total` 0) now reads as complete in the
  extension, not 0%. Core and `overallSyncProgress` have always read it that
  way — a fresh wallet's unshielded progress is legitimately 0/0.
- Percentages floor rather than round, so a part at 12.75% reads `12%`, not
  `13%`. Overstating is the failure this change is about.
