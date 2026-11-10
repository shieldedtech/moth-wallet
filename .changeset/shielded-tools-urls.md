---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-extension': patch
---

fix: point the hosted network endpoints at `*.shielded.tools`

The built-in mainnet, preprod, preview, qanet and devnet presets now use `rpc.<network>.shielded.tools` and
`indexer.<network>.shielded.tools`, and the documented faucet is `faucet.<network>.shielded.tools`. Wallets with custom
endpoints keep them.

The extension's host permission moves from `https://*.midnight.network/*` to `https://*.shielded.tools/*`, which also
covers the preprod indexer the previous release already switched to. Chrome may ask existing users to re-approve the
extension's site access on update, and custom endpoints on a `*.midnight.network` host are no longer covered.
