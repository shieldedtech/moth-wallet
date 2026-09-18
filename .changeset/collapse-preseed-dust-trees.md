---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-browser': patch
'@shieldedtech/moth-cli': minor
'@shieldedtech/moth-extension': minor
---

Collapse the DUST trees in pre-seed references, so a wallet seeded from one
restores its dust state in milliseconds instead of about a minute on every
launch.

A new wallet inherits the reference's dust state, and restoring it is one
`DustLocalState.deserialize` each time the CLI, TUI or extension starts the
wallet. On preprod that state was 5,474,535 bytes, nearly all of it a DUST
generation tree bloated by a ledger-v8 8.1.x defect, and the deserialize took
~57s. Collapsing the populated range of the generation and commitment trees
takes it to 3,666 bytes and ~7 ms, with the same roots and frontier:

| Network | Dust state | Deserialize |
| --- | --- | --- |
| preprod | 5,474,535 B → 3,666 B | ~57s → ~7 ms |
| preview | 131,427 B → 3,564 B | 65 ms → 7 ms |

A collapsed reference syncs forward exactly as the original: replaying the
71,507 preprod events that followed the reference on both — 940 of them dtime
updates landing inside the collapsed range — gave identical roots, balance and
UTXOs after every batch. The unit tests replay a recorded preview slice to keep
proving it.

The collapse is verified before anything uses it, refuses any state that owns
DUST (collapsing an owned leaf panics on 8.1.x), and runs wherever a reference
is produced or handed out: `moth preseed build`, `refresh`, `import` and
`export`, the extension's "Speed up new accounts" setting, and the first time a
reference stored by an earlier version seeds a wallet. **Existing wallets are
not affected**: only the reference is collapsed, so a wallet seeded before this
change keeps the dust state it was seeded with (and collapsing a wallet that
holds DUST is unsafe on ledger-v8 8.1.x).

`scripts/collapse-preseed.mjs` collapses a bundle directory, and with `--check`
proves one is collapsed and valid. `scripts/export-preseed.mjs` now collapses
on the way out and refuses an export it cannot verify.

Also in this change:

- **`moth preseed import` no longer drops a bundle's cursor witnesses.** It
  read only the three `.dat.gz` parts, so every imported reference was
  unverifiable, and a bundle cut before an indexer renumbering imported and then
  failed its sync in a loop instead of being refused. Both witness formats — the
  `witness-<part>.json` files `preseed export` writes and the inline witnesses in
  the extension's bundles — are now imported, and a malformed or missing one is
  refused. Conflicting sidecar and inline witnesses are also refused before
  any stored reference changes. Legacy unwitnessed imports remain supported.
- **The extension retains references used by existing wallets.** Per-wallet,
  per-network assignments preserve birthday-compatible recovery after an upgrade
  or background refresh. New versions and assignments publish atomically, and
  cursor witnesses are checked before seeding. Unassigned old versions are
  collected. Resync still clears caches and references and then attempts to
  install the bundled reference, as it did before this PR.
- **IndexedDB writes report success only after the transaction commits**, so a
  failed publication cannot appear successful after just its write request.
- **New wallets can prepare the next reference in the background.** After their
  first full sync, an isolated worker checks immutable snapshots for all
  ownership and pending records, replaces public identities, optimizes and
  verifies the trees, and publishes a witnessed reference for future wallets.
  Live wallets are never modified; imported and resumed wallets do not donate.
  Settings also offers an explicit background Update action. Reset and wallet
  removal invalidate any late background result.
- **The preview and preprod bundles are re-cut and collapsed.** Preprod's
  indexer renumbered its event ids after the previous bundle was cut, so its
  witnesses no longer matched and the extension refused it.
- **The qanet bundle is removed.** qanet's indexer was unavailable, so it could
  not be re-cut or verified. qanet wallets sync from genesis, and the extension
  offers to build a reference on the device, until a bundle returns.

CI now checks the committed bundles are collapsed on every pull request and
before packaging the extension, and runs an end-to-end test on every pull
request that seeds a new CLI wallet on preprod from the committed bundle and
checks it restores in seconds (advisory: it depends on the live preprod
indexer). The manual preseed workflow collapses, verifies and end-to-end tests
each bundle before uploading it. See
docs/adr/0006-collapse-preseed-dust-trees.md.
