---
'@shieldedtech/moth-wallet': patch
---

Refuse mainnet at the `--network` flag, not in one of its consumers.

The refusal lived inside `BaseCommand.getNetworkConfig`, and twelve commands never
call it — including both that create wallets. `moth wallet generate --network
mainnet` derived mainnet addresses, wrote a keystore, printed a recovery phrase
and exited 0, with no warning shown. A guard in one consumer is not a guard; it is
a convention that holds wherever someone remembered it.

It now hangs off the `--network` flag that every command inherits through
`baseFlags`, so no command can take a network id without it. `getNetworkConfig`
keeps the check as defence in depth, for an id arriving from stored config or from
a caller assembling flags itself, and both now route through one
`assertNotMainnet`.

Verified across the paths the issue did not cover: `wallet generate`, `wallet
import`, `wallet use` and `tui` all now print the warning and exit 1 without
writing a keystore, while `--network preprod` is untouched.

Also guards `config set default-network mainnet`, which is the second way a
network id enters the CLI — `WalletManager` falls back to `config.defaultNetwork`
for a wallet with no network of its own, so a stored value reaches the same code
paths without `--network` ever being used. Note that path is currently unreachable
for an unrelated reason: `moth config` declares an optional argument before a
required one, which oclif rejects, so every invocation of that command fails
before it runs. Filed separately.
