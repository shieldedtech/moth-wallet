---
'@shieldedtech/moth-wallet': patch
---

Pre-seed the DUST state of restored wallets when the indexer proves it safe.

Pre-seeding only ran for a wallet whose birthday was at or after the reference
height — the birthday being the wallet's only local proof that it has no earlier
history to skip. A wallet restored from a mnemonic or hex seed has no birthday,
and a wallet whose cache was cleared has one that predates the reference, so
both walked DUST from genesis: 1.4M events at ~293 events/s, about 78 minutes on
preprod, of which dust is 99%.

For the dust part there is a second proof. All of a wallet's DUST descends from
generation entries owned by its dust key, and the indexer can say whether that
key owned any entry at the reference height: `Block.dustGenerationEndIndex`
gives the generation tree's size `N` at that height, and the bounded
`dustGenerations(dustAddress, 0, N − 1)` subscription ends with `complete` — no
owned entry before it is a positive "none" (~1.1 s on preprod). When the
birthday rule fails and the dust cache is missing, `startWalletSync` runs that
probe and on "none" seeds dust alone from the reference; shielded and
unshielded still scan from genesis, which is quick. The hour becomes the
reference's deserialize plus catch-up.

Fails closed: an owned entry, an indexer without the field (pre-4.2), a timeout
or an error all keep the genesis walk, with the reason in the sync progress
line. The decision is the pure `preSeedPlan` (`sync/preseed-parts.ts`); the
probe is `sync/dust-history.ts`; `IndexerClient.getDustGenerationEndIndex` and
`dustAddressForKey` (a dust address from the typed key, no seed needed) support
it. ADR 0003 records the exception.
