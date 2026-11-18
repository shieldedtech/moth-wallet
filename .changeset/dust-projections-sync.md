---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-browser': minor
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-tui': minor
'@shieldedtech/moth-cli': minor
---

From the v9 fork on, the DUST wallet syncs from the indexer's DUST projections
instead of replaying every DUST ledger event, so its sync scales with the
wallet's own activity rather than the chain's length.

Below the fork nothing changes: ledger-v8 has no projections path, so the wallet
replays events as before, and at the fork it hands its state over to the
projections side. After the fork, each sync pass runs every 5 seconds rather
than following a live subscription, and a restart resumes from the block height
the saved state reached.

Pre-seeding no longer records a cursor witness for a DUST reference the
projections sync wrote. Its offset is a block height rather than an event id,
so an indexer renumbering cannot misplace it.
