---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-browser': minor
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-tui': minor
'@shieldedtech/moth-cli': minor
---

Add `local`, midnight-node's local-env (`ws://localhost:9933`), as a network of its own. It is no
longer folded into `undeployed`: local-env's network id reaches its addresses (`mn_addr_local1…`),
so serving it as `undeployed` derived the wrong prefix and read every unshielded balance as zero.
Stored `local` selections, wallets, birthdays and endpoint overrides now stay on `local`.

- `--network local` now targets 9933. Scripts that used it as an alias for the 9944 dev stack must
  switch to `--network undeployed`.
- Wallets that 0.13.0–0.14.1 already rewrote to `undeployed` stay there: select Local again, or
  recreate the wallet.
