---
'@shieldedtech/moth-wallet': patch
---

Make `moth dust status` work — it could not, on any network.

It passed the wallet's Midnight bech32m address to
`dustGenerationStatus(cardanoRewardAddresses:)`, which requires a Cardano reward
address. The indexer rejected it on the HRP before looking anything up, so every
invocation failed:

```
Error [NETWORK_ERROR]: Indexer error: invalid Cardano reward address:
  invalid HRP for Cardano reward address: mn_addr_preprod
```

The source said as much — "For now, use the wallet address as a placeholder" — and
there was no flag to supply the right address, so the command had no working path.
It was the only caller of that query.

The indexer splits this question in two, and the halves take different keys:

| | keyed by |
| --- | --- |
| query `dustGenerationStatus` | `cardanoRewardAddresses` |
| query `dustGenerations` | `cardanoRewardAddresses` |
| **subscription `dustGenerations`** | **`dustAddress`** |

Only the subscription is keyed by something moth derives, so that is what this now
uses: the wallet's own DUST address, reporting the generation entries accruing to
it, their total value, and the newest one's timestamp. That is almost certainly
what someone typing `moth dust status` wants to know.

The command now unlocks the wallet, because a locked one has no addresses to read
— `list()` returns empty encodings by design.

Collection is time-bounded rather than complete: the subscription stays open for
future entries, so `DustGenerationsProgress` ending it is the only "caught up"
signal there is. When the budget ends it first, the output says `truncated` rather
than presenting a partial list as whole.

Still unavailable: registration state, generation rate and capacity for a cNIGHT
holder. Those are the `cardanoRewardAddresses` half, and they need a Cardano stake
address moth does not derive — see ADR-0007. A `--cardano-address` flag is the
natural home when that lands.
