---
'@shieldedtech/moth-extension': patch
---

Stop a superseded wallet publishing its balance after a wallet switch.

`syncEnsure` records the session in `current` before awaiting the sync start, so
switching wallets while one is still starting supersedes that record. When the
first start finally resolved it subscribed unconditionally — and core's
`subscribe` invokes the callback synchronously with that wallet's own balances
before returning — so the superseded wallet published one `os/eventBalances`
into the shared channel after the user had already moved on. The panel showed it
as the balance of the wallet being viewed.

It shows until the active wallet next emits, and a synced wallet emits only on
change, audited at one second — so the wrong figure can sit on screen for
minutes rather than flicker. Two wallets whose balances differ made this look
like a balance flipping between two values.

The emission is now dropped unless its wallet is still the active one. Where the
existing `current?.key === key` guard fails, the unsubscribe handle is called
rather than discarded: nothing would ever have stored it, so `syncStop` could
not have reached it and the callback stayed in core's subscriber list for the
lifetime of the document.

The rejection path is guarded the same way. It nulled `current` without checking
whose it was, so a start failing after `syncStop`'s 30s bound would have torn
down the session of the wallet the user had switched to.

No arithmetic changed. Both balances were always correct; only the attribution
was wrong.
