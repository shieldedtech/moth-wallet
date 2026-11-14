---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-extension': patch
---

fix: point the hosted network endpoints at `*.shielded.tools`

The built-in mainnet, preprod, qanet and devnet presets now use `rpc.<network>.shielded.tools` and
`indexer.<network>.shielded.tools`. This repairs mainnet: its old indexer, `indexer.mainnet.midnight.network`, has been
retired and answers 410, so the mainnet preset could not sync. qanet and devnet's new hosts resolve to private addresses, so reaching them needs
the VPN. The preview preset stays on `*.midnight.network` until its `shielded.tools` hosts have DNS records. Wallets
with custom endpoints keep them.

The extension adds a `https://*.shielded.tools/*` host permission alongside `https://*.midnight.network/*`, so a node
auth header set in Settings is still attached now that the nodes have moved. Because the update adds a host permission,
Chrome may disable the extension on update until the user accepts it.
