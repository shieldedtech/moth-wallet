---
'@shieldedtech/moth-wallet': patch
---

Read the birthday back, so a CLI or TUI wallet can actually pre-seed.

The birthday was written and never read. `startWalletSync`'s pre-seed gate is
`(isNewWallet || birthday)`, and no CLI command passed either — eleven of them
stopped at `walletName`, and the TUI hook passed `isNewWallet` but no birthday,
so the guard `emptyRef.height <= birthday` could never be reached. The effect was
silent: `moth balance -n preprod -v` showed no pre-seed line at all and dust began
at 0%, with the reference sitting unused.

Every sync call site now passes it, resolved through a new
`WalletManager.birthdayOn(name, networkId)`. Per network on purpose: `list()`
resolves against the wallet's own `meta.network`, so a sync driven by `--network`
was reading a height belonging to a different chain, or nothing at all. It never
throws — a wallet with no meta asserts nothing, and "no claim" means scan from
genesis, which is slow but never wrong.

The write side was missing here too: `moth wallet generate` never passed a
birthday, so CLI-generated wallets recorded none at all and could not pre-seed
even once the read side worked. Both the CLI and TUI generate paths now record
the chain tip, as the extension already did.

Guarded by a test that walks the AST of every `startWalletSync` call in the CLI
and TUI and fails any that omits the birthday, since nothing else would notice
this regressing. Verified by deliberately dropping the argument.
