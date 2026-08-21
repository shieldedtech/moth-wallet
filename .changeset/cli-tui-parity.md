---
"@shieldedtech/moth-wallet": minor
"@shieldedtech/moth-cli": minor
"@shieldedtech/moth-tui": patch
---

Give the CLI and TUI the pre-seed, timings and DUST-registration behaviour the
extension already had.

**Birthdays.** `chainTip` moves from the extension's background handlers into
core, and `wallet generate` on both surfaces records the chain tip as the new
wallet's birthday. Without one the `reference.height <= birthday` guard can never
pass, so no CLI or TUI wallet could ever be pre-seeded — the difference between
29.3s and 78.6 min on preprod. Imports still get none, deliberately: a restored
wallet may hold funds at any height, and seeding it past its own history would
lose them silently.

**`moth preseed status|refresh|build`.** Thin wrappers over core functions
that already existed but had no caller outside the extension. `refresh` is the
one worth having — 9.1s to catch a reference up, against 53.6 min to rebuild it
from genesis, which is what someone does by hand when the command is missing.
`build` says how long it will take before starting, because an unattended command
that appears to hang for an hour is indistinguishable from a broken one.

**Phase timings on disk.** `createFileTimingStore` backs the existing
storage-agnostic recorder with `~/.moth/timings.json` — the path
`docs/BENCHMARKING.md` already documented and nothing wrote. `moth diagnostics
timings` shows the timeline as deltas, and recording stays off until switched on.
A headless sync is where this matters most: it is the surface with no other
signal about where the time went.

**DUST registration in the TUI.** `DustRegistrationNotYetError` is now caught
distinctly, so a wallet whose NIGHT is too new to cover the registration fee is
told "not yet" instead of shown the raw SDK error as a failure. The panel and the
CLI already did this; the TUI was the surface still reporting it as a defect.
