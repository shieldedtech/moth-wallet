---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-cli': minor
'@shieldedtech/moth-browser': patch
'@shieldedtech/moth-tui': patch
---

Sign the unshielded inputs a contract call needs, and report individual shielded coins.

Two capabilities that existed as unapplied local patches and never reached the
tree. Both are prerequisites for a DApp that moves tokens through a contract,
and their absence produced two failures that looked unrelated.

**Unshielded input signatures.** A circuit calling `receiveUnshielded` produces
a transaction carrying unshielded UTxO inputs, and every such input needs a
matching signature. `moth call` did not add them, so the node rejected the
transaction with `1010: Invalid Transaction: Custom error: 192`
(`InputsSignaturesLengthMismatch`). Deploy was unaffected — it spends only DUST
on fees — which made the failure look contract-specific rather than tooling-wide.
`contract/call.ts` and `contract/deploy.ts` now build and sign the offer.

**Shielded coin enumeration.** A Compact circuit that takes a coin needs
`{nonce, type, value}`, and no DApp-side source exposes them: the connector has
no coin enumeration, `getShieldedBalances` returns per-token totals only, and
the indexer's Zswap state is contract-filtered. The connector gains
`getShieldedCoins`, and the CLI a `balance --coins` flag, both reporting
per-coin nonce, type, value, Merkle index, commitment and status. Without it a
wallet cannot offer the user a coin to spend — the sNIGHT unwrap flow has no
way to populate its selector.

Also adds a Settings action to rebuild only the shielded sub-wallet, so a stale
shielded view can be repaired without forcing the much slower DUST rescan.
