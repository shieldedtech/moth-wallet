---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-tui': patch
---

Make wallet switching fast: an opt-in pool of warm syncs, and stop paying for the
outgoing wallet's teardown on the way to the incoming one.

Switching wallets was slow even between wallets on the same network, because
nothing about a sync is shared per-network. The cache entries
(`sync/<network>/<wallet>/<part>.dat`), the WASM sub-wallet state and the indexer
subscription are all per-wallet, so every switch rebuilt the whole thing:
serialize four caches, stop the SDK, deserialize three sub-wallets, re-init the
facade, reconnect, then wait up to 5s for a first state emission — and it did all
of that strictly after awaiting the outgoing teardown, which is itself bounded at
5s against a node whose client never settles.

- **`WarmSyncPool` (opt-in, off by default).** Parks the outgoing facade instead
  of stopping it, so switching back to a wallet is a re-subscribe rather than a
  rebuild. Enabled in the TUI with `warmWallets` in `~/.moth/tui/settings.json`,
  or `MOTH_WARM_WALLETS` per run; capped at 5. Each warm wallet keeps its full
  sync state resident and its indexer subscription open — roughly the cost of a
  second wallet syncing — which is why it is opt-in rather than a tuned default.
  Warm facades hold live keys, so they are evicted before anything frees key
  material (lock, quit) or clears stored state (remove, clear sync cache), and a
  reused facade re-asserts the SDK's global network id the cold path would have
  set.
- **The outgoing teardown is no longer awaited when the incoming sync is for a
  different wallet or network.** Those write disjoint cache entries, so the wait
  bought nothing. A restart of the same wallet still awaits, since there the two
  do overlap.
- **`NodeSyncStateStore.put` writes atomically** (temp file + rename). Sync state
  entries are large and were written in place, so a concurrent reader could decode
  a truncated one — which the restore path treats as "sync from genesis". Now that
  a switch can leave two syncs briefly alive, that went from exotic to ordinary.
- **Fixed spurious sync restarts.** `getActiveWalletKeys`, `isActiveWalletNew` and
  `activeWalletBirthdayOn` depended on the whole `activeWallet` object, which
  `refresh()` rebuilds on every call, so creating, importing or removing any
  wallet tore down and rebuilt the sync of the active one. They only read the
  name, so that is what they depend on now.
- **Locking a wallet takes its syncs down before zeroing its keys**, warm and
  foreground alike — the ordering quit already used, extended to the lock path.
