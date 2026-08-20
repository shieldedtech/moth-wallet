---
'@shieldedtech/moth-wallet': minor
---

Keep one pre-seed reference per height, so an asserted birthday can seed from a
reference below it.

Asserting a birthday was not enough on its own. A reference is the chain's state
at a single height, not a searchable record of the blocks under it, so a wallet
whose birthday precedes the reference cannot use it — and the fallback is the
genesis walk the pre-seed exists to avoid. It failed quietly: on preprod an
import with a date-derived birthday of 1,905,019 against a reference at 2,104,384
reported the birthday stored, then had not finished DUST (21%) after 2600s, where
a wallet born at tip synced in 110.6s.

Each successful build now also archives the reference under the height it
reached, indexed in `empty-ref/<network>/archive.json`. Given a birthday, the
lookup prefers the live reference when it is at or below that birthday, else
takes the newest archived one at or below it, else scans from genesis. Only the
live reference is memoised — an archived choice belongs to one birthday, not to
the network. `birthdayOutlook()` runs the same selection, so what an import
predicts is what the sync does.

The safety rule is unchanged: a reference above the birthday is never used, and
an indexed archive whose parts are absent from the store is skipped rather than
trusted.

All three surfaces read the archive, and all three can now see it. New CLI
commands `moth preseed status` (heights held, and the earliest birthday that can
skip the chain walk) and `moth preseed build` (build and archive at tip, resumable,
`--force` to rebuild). The TUI's Network screen shows the same figures read-only —
building stays a CLI job, since it is a tens-of-minutes sync. The extension's
bundled reference is archived at its own height too, and is no longer discarded
when a locally built reference already holds the live slot: the bundle usually
sits lower, which is exactly the coverage an earlier birthday needs.

A build also archives whatever the live slot held before advancing it, since the
build resumes the same reference wallet forward and the older, lower height would
otherwise be lost.

Archives accumulate forward — building a reference at a height already in the
past needs either a block-height-to-DUST-event-id query from the indexer or
sync-to-height in the wallet SDK, since sync progress is reported only in event
indices. The CI cache therefore carries `__empty_ref__*` and `archive.json` so
successive runs leave a denser archive. See ADR 0003.
