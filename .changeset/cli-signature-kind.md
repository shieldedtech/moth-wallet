---
'@shieldedtech/moth-wallet': minor
---

Let the CLI create ECDSA wallets, and refuse the combination that cannot work.

`wallet generate` and `wallet import` take `--signature-kind schnorr|ecdsa`, and
`WalletManager.import` / `importFromSeed` accept and record it alongside
`generate`. ECDSA on a ledger v8 network is refused with an explanation rather
than producing a wallet with no unshielded address there.

`wallet list` shows a `signing` column, populated only for ECDSA.
