---
'@shieldedtech/moth-wallet': minor
---

**`undeployed` replaces `local` as the local devnet network.** Every interface now
offers it, including the extension, which could not select it before.

The two were duplicate presets for the same thing. `undeployed` is the id the
Midnight tooling, `docs/TESTING.md`, and this repo's own README instructions all
use for the local stack, and it points at the node port that stack listens on —
`9944`. `local` pointed at `9933`, which nothing in the documented stack serves,
so selecting **Local** in the extension connected to a closed port. It has been
that way since the first commit.

`local` was kept out of the extension's picker by a comment claiming the wallet
could not derive addresses for `undeployed`. That was false: `mn_addr_undeployed1…`,
`mn_dust_undeployed1…` and `mn_shield-addr_undeployed1…` have always derived, and
`address-parity`'s network loop stopping at `qanet` is why nothing contradicted it.
The loop now covers `undeployed` and `stagenet`, and a new test holds
`SUPPORTED_NETWORKS` equal to the keys of `DEFAULT_NETWORKS`, so a preset no
interface can reach — or an offered network with no preset — fails the suite.

**Breaking, with a migration.** `local` is gone from `SUPPORTED_NETWORKS` and
`DEFAULT_NETWORKS`, and the extension rejects it on save. Read paths resolve it via
`canonicalNetworkId`, exported from core: the extension's stored selection, a
wallet's meta record, the TUI's `lastNetwork`, `--network local`, and
`createMothBrowser({ network: 'local' })` all continue to work and land on
`undeployed`. Per-network birthdays and endpoint overrides move across with it, so
a migrated wallet keeps its pre-seed shortcut instead of resyncing from genesis.
Stored records are rewritten lazily, only when something else is already saving
them. `local` stays in `ALL_NETWORKS` so addresses already handed out still resolve.

Sync caches are keyed by network, so a migrated account resyncs once under the new
key — correct, since the node URL genuinely changes — and its old entries are left
behind rather than cleaned up.

Also fixed alongside: the four localhost indexer fallbacks pointed at
`http://localhost:8088` without the `/api/v4/graphql` path the indexer client posts
queries to, and the README's network table listed `devnet` as localhost, omitted
`undeployed`, and gave qanet hostnames (`rpc.qanet.dev.midnight.network`) that do
not resolve. Mainnet stays out of both the table and the `--network` reference:
the CLI refuses it and the extension keeps it out of the picker, so documenting
its endpoints only invites someone to try.
