---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-cli': patch
'@shieldedtech/moth-extension': patch
---

Run ledger v9 networks on Midnight wallet SDK 2.0.0-rc.1 (ledger-v9 1.0.0-rc.5),
and recognise ledger 9.1 networks.

The previous v9 line (wallet SDK 2.0.0-beta.2, ledger-v9 rc.3) cannot pay fees
on a ledger 9.1 rc.4 node, and its DUST wallet can loop forever balancing a fee
once a wallet holds several part-drained DUST coins (midnightntwrk/midnight-wallet#741).
rc.1 fixes both.

- Protocol versions map to ledgers by range, as the wallet SDK does: ledger 9.1
  networks report 2001000 and were refused as unrecognised.
- Ledger detection is cached per indexer endpoint, so a network with overridden
  endpoints no longer inherits what its preset reported, and the wallet manager
  no longer replaces a ledger the CLI, TUI or extension loaded from the
  effective endpoints with the preset's.
- CLI commands resolve the network before unlocking, so wallet keys are built
  for the ledger the network runs; sync refuses keys from another ledger with a
  clear error.
- On the v9 SDK, sync uses the ledger-v9 (V2) wallet variants, single-variant,
  over one v9 epoch. Facade calls that changed shape (keys no longer passed per
  call, transactions carried as `WalletTransaction` handles, per-ledger proving
  service names) go through `sync/facade-compat.ts`; the v8 path is unchanged.
- A wallet only reports synced once its sub-wallets have settled on one
  protocol version.

Contract deploy and call still use midnight-js 4.1.1 and remain ledger v8 only.
