---
'@shieldedtech/moth-wallet': patch
---

Make the birthday and pre-seed decisions visible in the log, with timings.

The information needed to explain a slow first sync was mostly absent. The
birthday was logged only when the pre-seed was *refused*, never on success; the
reference height that was actually used was never logged at all; the packaged
reference install wrote ~11 MB into IndexedDB silently; and nothing anywhere was
timed. A sync that quietly started at genesis therefore looked identical to one
that seeded.

Now logged: the birthday and which parts need seeding before the attempt, which
reference height was selected and how long finding it took, and on success the
parts seeded, the block they were seeded to, the birthday they were checked
against, and the elapsed time. The indexer's first-activity query reports its own
round trip — measured against preprod at 497–828ms — beside the height and
transaction id it returned. The extension logs the packaged reference install and
how long it took.

Two stale messages fixed while there: "no reference at chain tip for this
network" and "Pre-seed complete — … at chain tip" both predate references at
arbitrary heights. Usability is no longer about the tip, so they now name the
birthday being compared and the block actually seeded to.
