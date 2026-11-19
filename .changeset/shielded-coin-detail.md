---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-cli': minor
'@shieldedtech/moth-tui': patch
'@shieldedtech/moth-extension': minor
---

Report each shielded coin with the fields needed to spend it.

A Compact circuit that takes a coin needs its nonce, type, value and Merkle index
(a `QualifiedShieldedCoinInfo`). Only the wallet has these: the dApp connector API
has no coin enumeration, and the indexer's Zswap state is filtered to one contract,
so it cannot give a global Merkle index. Sync kept only each coin's value and type.

- Core keeps the nonce, Merkle index and commitment on every shielded coin
  (`ShieldedCoinInfo`), and `shieldedCoinRows` lists them in the field names a
  circuit takes. The nullifier is never included.
- The extension adds the connector method `getShieldedCoins`, outside the standard
  API like `deriveAppSecret`. It returns `{synced, coins}`, so an empty list can be
  told apart from one sync has not filled yet. It needs a connected dApp and asks
  the user every time, as `deriveAppSecret` does: the list shows the site every
  shielded coin, nonces included, where `getShieldedBalances` shows only totals.
- `moth balance --coins` lists the same coins, as text or JSON.
- The TUI dashboard shows each shielded coin's Merkle index and nonce prefix.

Coins booked by a transaction still in flight are not listed as available:
wallet-sdk 2.0 already leaves them out of `availableCoins`.
