---
"@shieldedtech/moth-cli": patch
---

`moth dust status` reads the wallet's own DUST state instead of guessing at a Cardano address.

It used to hand `WalletInfo.address` to the indexer's `dustGenerationStatus(cardanoRewardAddresses:)` query, with a comment in the code saying the address was a placeholder. Two things were wrong with that, and fixing either alone left the command broken.

The stored address is written once at create/import and carries that moment's network HRP, so `--network preprod` changed which indexer was called and not which address was sent. A wallet created on devnet and since used on preprod — same keys, both encodings valid — was rejected outright:

```
Error [NETWORK_ERROR]: Indexer error: invalid Cardano reward address:
invalid HRP for Cardano reward address: mn_addr_devnet
```

And a Midnight address is never a Cardano reward address in the first place. DUST generation tracks NIGHT held on Cardano, so that query wants `stake1…`; devnet's indexer tolerated the wrong kind of input and preprod's did not.

The command now reports the wallet's own generation state — registered NIGHT, DUST balance, rate, cap, UTXO count, fill time — the same data the TUI's DUST panel shows, on whichever network the wallet is used on. It does not wait for a full sync: the dust stream is the slowest by two orders of magnitude while registration comes from the unshielded one, so the answer arrives without a chain walk, and the output says whether dust had finished catching up rather than presenting a mid-sync reading as settled.

`--reward-address stake1…` keeps the Cardano-side lookup for the different question it actually answers, and validates that what it is given is a reward address rather than forwarding it and letting the indexer's parser produce the diagnostic.
