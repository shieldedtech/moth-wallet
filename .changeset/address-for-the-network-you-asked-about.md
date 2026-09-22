---
"@shieldedtech/moth-wallet": patch
"@shieldedtech/moth-cli": patch
---

Report a wallet's address for the network you asked about, not the one it was created on.

`WalletMeta.address` is written once, at create or import, with whichever network was current then. A wallet created on devnet and since used on preprod therefore reported a devnet address forever — while being fully synced and funded on preprod — and any caller that forwarded that value sent a wrong-network address wherever it went. `moth dust status` did, and preprod's indexer rejected it outright (#107).

A Midnight address is a payload plus a network prefix, and the payload is key material with no network of its own: `mn_addr_devnet18ph9d9…eskkpdrr` and `mn_addr_preprod18ph9d9…esngsypp` both decode to `386e5697…97c73`. So the correct address for any network is available by re-encoding, with no keys and no unlock — which is what the TUI has always done by deriving from keys, and why it showed the right address while the CLI did not.

- New `addressForNetwork(address, network)` in core: re-encodes, returns the input unchanged when it already matches, and null rather than throwing on input it cannot parse.
- `WalletManager.list()` takes an optional network and encodes each `address` for it; omitting it preserves the previous behaviour exactly. A new `addressNetwork` field always says which network the returned address is for, so a caller never infers it from the prefix.
- `moth wallet list` asks for the network being worked with, and its single `network` column — which read as "the only network this wallet works on" — is now `created on` plus `address for`, because those routinely differ.
