---
'@shieldedtech/moth-wallet': minor
---

Four CLI fixes found by a manual test pass, none of which the test suite could see.

**Amounts are parsed strictly (#63).** `moth transfer` used `parseFloat` and
`Math.round`, and `parseFloat` keeps whatever prefix it understands: `1,5` was
accepted as **1 NIGHT**, losing a third of the value with no warning; `0.0000001`
rounded to **zero base units** and was submitted as a transfer that moved nothing
and still paid a fee; `1e3` became 1000 NIGHT; `1abc` became 1. A shared
`parseNightAmount` in core now refuses all of them, in BigInt, with a message
naming what is wrong — and `daemon transfer` already did it this way, so the two
paths finally agree.

**`moth transfer` can select a token (#62).** It hardcoded `NIGHT_TOKEN_ID`, so a
wallet holding anything else could spend it only through `daemon transfer
--token-id`. Same flag name and default here. The positional amount stays a NIGHT
decimal and is refused for other tokens, directing to `--amount` in raw base units
— mis-scaling a token by NIGHT's 10⁶ would be worse than refusing.

**`moth wallet export-phrase` exists (#59).** `WalletManager.exportPhrase` and
`exportSeedHex` have always been in core, and the extension exposes them, but no
CLI command did. So the CLI had no backup path — a phrase was shown once at
`wallet generate` and never again — no way to move a wallet between machines, and
no way to recover a seed for a keystore you hold the passphrase to. Confirmed by
default and refused non-interactively without `--yes`, following `wallet remove`.
A wallet imported from a hex seed says so rather than presenting a seed as a
phrase.

**`wallet address` takes `--wallet` (#60).** It was the only command in the CLI
requiring `--name`, which made it the only one that could not act on the active
wallet: `wallet use w1` then `wallet address` failed with "Missing required flag
name". `--name` remains as an alias.

**`dust register` distinguishes empty from done (#58).** `designateForDust`
returns `null` both when every UTXO is already designated and when there are no
NIGHT UTXOs at all, and the command reported the first for both — vacuously true
of an empty wallet, and read as success. An unfunded wallet now gets "No NIGHT to
designate" and a non-zero exit.
