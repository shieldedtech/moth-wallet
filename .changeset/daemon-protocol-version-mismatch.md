---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-cli': minor
---

The daemon's `submitTransaction` answers `PROTOCOL_VERSION_MISMATCH` instead of `INVALID_PARAMS`
when the hex is a transaction built for the other side of the ledger fork, or when the wallets
cross the fork before it is submitted. Hex that no ledger reads still gets `INVALID_PARAMS`.
`RpcErrorCode` gains the new member, and the CLI renders it as `INVALID_INPUT` with a "Protocol
version mismatch" prefix.
