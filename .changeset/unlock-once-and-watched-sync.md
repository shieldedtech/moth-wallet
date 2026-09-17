---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-extension': patch
---

Unlock decrypts the keystore once, and a sync you are watching no longer gets
auto-locked out from under you.

**One KDF per password entry.** The extension's offscreen key-holder needs both
the unlocked key bundle and a serializable seed (to rebuild the bundle after
Chrome recreates the offscreen document), and got them with `unlock()` followed
by `exportSeedHex()` — two full keystore decrypts, each a scrypt derivation at
`N = 2^18` in pure JS, so several seconds of every unlock were spent deriving
the same key twice. Core gains `WalletManager.unlockWithSeedHex`, which returns
the seed beside a seed-free `UnlockedWallet` from a single decrypt; the
extension uses it. `unlock()` is unchanged and stays seed-free for every other
caller (D-KM-3; the spec's "Concretely" list records the exception).

**A watched sync is activity.** The inactivity clock only advanced on the user's
own input, so a panel left open to watch a long first sync counted as idle and
the 15-minute auto-lock fired mid-sync — stopping the engine (its final cache
write survives, so no progress is lost) and greeting the user with a password
prompt and a cold restart. `enforceAutoLock` now treats "a panel is open, an
engine is running, and it has not yet reported itself synced" as activity: it
holds the lock and resets the clock, so the full window applies again once sync
completes. With the panel closed the idle teardown stops the engine within
seconds, so an unattended wallet is never kept open by this. The Settings
description says so; the README's stale "no inactivity auto-lock" note is
corrected.
