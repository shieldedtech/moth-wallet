---
'@shieldedtech/moth-wallet': minor
---

Install the packaged pre-seed reference instead of rebuilding it.

The repo commits a reference per network for the extension to bundle, but nothing
read those files back. The CLI and TUI use a different store (`~/.moth`), so a
fresh checkout's only route to a reference was `preseed build` — an empty wallet
synced to tip, tens of minutes of DUST — while byte-identical state sat in the
checkout.

`moth preseed install` imports it in seconds. The height is written last, so an
interrupted install is ignored rather than half-trusted; the outgoing reference is
archived before replacement, since it is usually lower and therefore covers
earlier birthdays; and a partial set is refused rather than mixed.
