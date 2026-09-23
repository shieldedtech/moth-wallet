---
'@shieldedtech/moth-tui': patch
---

Show when the DUST view is incomplete, and host the dust rebuild verbs.

The Dust Wallet block of the state view gains a `View` row when the sync
engine's check against the chain finds coins missing, a stalled cursor or a
rejected replay, naming the reason and the repair (`moth dust rebuild`). The
TUI's daemon socket now answers `checkDustView`, `rebuildDust` and
`restartSync` for the selected wallet.
