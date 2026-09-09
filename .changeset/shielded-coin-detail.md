---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-cli': minor
'@shieldedtech/moth-tui': minor
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-browser': minor
---

Report shielded coins in enough detail to spend them, stop offering coins that
were already spent, and group `moth balance` the way the ledger actually does.

**Shielded coin detail.** The sync layer kept only `{value, type}` from the SDK's
`AvailableCoin` — enough to show a balance, not enough to spend. The nonce and
Merkle index were dropped, and nothing outside the wallet can reconstruct them:
the connector has no coin enumeration, a history entry is only
`{txHash, txStatus}`, and the indexer's `queryZSwapAndContractState` returns a
contract-filtered Zswap state whose `firstFree` is 0, so it cannot yield a global
index either. The wallet is the only party tracking the global commitment tree
for its own coins.

Without it, no contract taking custody of a user's shielded coin — vault,
wrapper, escrow — is callable from a DApp, because a Compact circuit taking a
coin as an argument needs `{nonce, type, value}`. Verified by building one: a
NIGHT wrapper completes wrap, private transfer to a third party, and that party
unwrapping, on preprod.

Surfaced through `moth balance --coins`, the TUI dashboard, and a
`getShieldedCoins` connector method. The method returns the sync state alongside
the coins, because an empty list is otherwise ambiguous between "still scanning"
and "none", and reporting no coins mid-rescan is the wrong answer. It has its own
offscreen route rather than reading the balances snapshot, since
`serializeForClients` deliberately blanks `coins` — the dust list grows
throughout sync and shipping it on every ~1s emission hitches the panel's main
thread.

**Spent coins were still being offered.** The SDK moves *unshielded* coins
available→pending when a transaction reserves them, so a spend shows up at once.
Shielded coins get no such treatment, and shielded `pendingCoins` also holds
*incoming* coins, so a spend cannot be inferred from it. A spent coin therefore
stayed in `availableCoins` until sync caught up.

That is not cosmetic: selecting it builds a transaction the balancer cannot
satisfy, surfacing as "Insufficient funds for fallible segment N" — an error
naming the wrong cause, because the coin genuinely no longer exists. Reproduced
end to end, then fixed by recording the nullifiers a submitted transaction
spends.

**`moth balance` grouping (#97).** It grouped under a NIGHT heading and labelled
every balance in STARS, including tokens for which STARS means nothing. The
categories are now what the ledger distinguishes — shielded, unshielded, DUST —
with NIGHT as a row under unshielded rather than a class of its own, and the
permanently-zero "shielded NIGHT" line gone. Contract-issued tokens carry a raw
amount and no unit instead of an invented denomination. Per-category totals are
removed, because different tokens are not summable and `unshielded + shielded`
was only harmless while shielded NIGHT was always zero. NIGHT
available/reserved moves out of the balance rows: it is a property of the UTxO
set, not the balance.

Underneath, `formatBalance` padded the fraction to six digits regardless of
denomination, so `formatDustBalance` dropped a DUST fraction's leading zeros and
overstated it by roughly 100x — `41004319999999999n` rendered as
`41.4319999999999` instead of `41.004319999999999`.
