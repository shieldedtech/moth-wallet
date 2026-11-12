---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-extension': patch
---

fix: point the hosted network endpoints at `*.shielded.tools`

The built-in mainnet, preprod, qanet and devnet presets now use `rpc.<network>.shielded.tools` and
`indexer.<network>.shielded.tools`. qanet and devnet's new hosts resolve to private addresses, so reaching them needs
the VPN. The preview preset stays on `*.midnight.network` until its `shielded.tools` hosts have DNS records. Wallets
with custom endpoints keep them.

The extension adds a `https://*.shielded.tools/*` host permission alongside `https://*.midnight.network/*`, which also
covers the preprod indexer the previous release already switched to. Chrome may ask existing users to re-approve the
extension's site access on update.
