---
'@shieldedtech/moth-wallet': minor
---

Let an import assert a birthday, and record when an account was created.

An imported wallet never gets a birthday, so its sync walks from genesis — on
preprod that is 1.4M DUST events, around 78 minutes — with a bundled reference
sitting unused. The rule is right (an imported seed may hold funds on any chain
at any height, and moth cannot know), but the user often does know, and had no
way to say so.

`wallet import` gains `--birthday-date`, `--birthday-height` and
`--birthday-tip`. A date is resolved by binary search over block timestamps —
about 21 lookups on a 2M-block chain — so it runs inline during the import.
`findHeightBefore`, `heightForDate` and `chainTip` are exported for other
callers.

`WalletMeta` also records `createdAtHeight`, the chain tip when the account was
created here. It is deliberately separate from `birthdays`: one is
informational, the other a claim the pre-seed acts on. `createdHere` remains the
gate for automatic birthdays, so an asserted one never changes what happens on a
later network switch.

`wallet list` shows the creation date and where a sync starts, and the
extension's Accounts view shows the same.
