---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-cli': minor
'@shieldedtech/moth-browser': patch
'@shieldedtech/moth-tui': patch
---

Report individual shielded coins, and repair a stale shielded view on its own.

A Compact circuit that takes a coin needs `{nonce, type, value}`, and no
DApp-side source exposes them: the connector has no coin enumeration,
`getShieldedBalances` returns per-token totals only, and the indexer's Zswap
state is contract-filtered. The connector gains `getShieldedCoins`, and the CLI
a `balance --coins` flag, both reporting per-coin nonce, type, value, Merkle
index, commitment and status. Without it a wallet cannot offer the user a coin
to spend — the sNIGHT unwrap flow has no way to populate its selector.

Adds a Settings action to rebuild only the shielded sub-wallet, so a stale
shielded view can be repaired without forcing the much slower DUST rescan. That
is also the recovery path when an indexer renumbering leaves a stored shielded
cursor pointing at a different event, which surfaces as
`values inserted non-linearly into zswap commitment tree`.

`deploy.ts` also gains `deepDumpError` behind `MOTH_DEBUG_ERR=1`: Effect's
FiberFailure keeps the real failure behind a symbol-keyed property, so a walker
following `.cause` alone reports only the outer message.

**Not included:** the unshielded-input signing fix this branch originally
carried. Signing was written back to the recipe, but the loss is one level
deeper — `signTransactionIntents` ends in `tx.intents.set(...)`, and ledger-v8's
`intents` getter returns a fresh Map per read, so the mutation is discarded
before any write-back is reached. Verified directly: `tx.intents !== tx.intents`,
and a mutation through the getter leaves `size` unchanged. #152 fixes this
properly by routing all four call sites through `facade.signRecipe` and deleting
the three hand-rolled helpers.
