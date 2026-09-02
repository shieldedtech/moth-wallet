---
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-wallet': patch
---

Settings → Network gains "Clear cache and resync".

A local network that goes down and comes back as a new chain from genesis
leaves the wallet holding state for a chain that no longer exists: the
account's serialized sync state, its pending submissions, and the network's
pre-seed reference that every fresh sync is seeded from. The engine cannot
tell, and the only ways out were switching indexer URLs or removing the
account. The new action, behind a confirmation, stops sync, drops all of that
for the active account on its network, clears the cached balance snapshot so
the loading screen shows, and starts syncing again from the start of the
chain. Nothing is spent.

Core gains `clearEmptyRefCache(networkId, store)` (`sync/preseed.ts`), which
removes the reference's state parts, height, cursor witnesses and mnemonic and
forgets the in-process memo — without the last, a worker that had already
verified the reference would keep handing the stale one out. `clearSyncCache`
now also evicts the ECDSA unshielded cache identity, which it previously left
behind for wallets of that kind.
