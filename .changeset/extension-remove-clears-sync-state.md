---
"@shieldedtech/moth-wallet": patch
"@shieldedtech/moth-browser": patch
"@shieldedtech/moth-extension": patch
---

Clear an account's sync state when it is removed in the extension.

Removing an account left its sync state behind, so re-adding the same seed
resumed the removed account's sync instead of starting fresh — the one recovery
a user reaches for when an account is stuck did nothing, silently. The only
visible difference was a `Restoring … from cache` line where `Pre-seeding …`
belonged. A name re-used with a *different* seed is the worse case: the wallet
would apply one seed's cached sub-wallet state while holding another's keys.

Two causes, both fixed here.

`WalletManager.remove()` cleaned the sync store that core resolves by default,
which on node is the fs-backed `~/.moth/sync` store — right for the CLI, TUI and
daemon — but in the browser is a volatile in-memory one. It never touched the
IndexedDB the extension actually writes. The manager now takes the store its
surface uses, and `createMothBrowser` hands it the IndexedDB one.

The sync engine also writes its final state when it stops, and the extension's
lock path starts that teardown without awaiting it. A removal racing that flush
deleted the state and had it written straight back, which is why a removed
account's dust cursor reappeared to the event. The offscreen host now stops the
engine before removing, and clears the two per-account keys core does not know
about: the local submission notes and the dust-repair stamp.

`remove()` additionally clears every network an account has been on rather than
only its current one. Switching networks deliberately keeps the previous
network's cache for a cheap return trip, and that cache outlived removal.

Removal is now also safe to interrupt. It writes the account list before
deleting anything that list points at, and the extension removes the account
before locking — locking starts a teardown it does not await, and teardown
closes the document doing the work, so the removal was racing its own shutdown.
Interrupted the old way, an account stayed listed with its keystore already
deleted: no passphrase could open it, and when it was the only account the
wallet had no way back in, because the "no accounts yet" screen needs an empty
list.

For profiles already in that state, a config entry whose keystore is missing is
now treated as the absent account it is — skipped by `list()`, and no longer
blocking a new account from taking that name. Note this changes what `list()`
reports on every surface, `moth wallet list` included: an entry with no keystore
is omitted rather than shown as an account that every operation would fail on.
