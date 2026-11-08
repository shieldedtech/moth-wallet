---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-cli': patch
'@shieldedtech/moth-tui': patch
'@shieldedtech/moth-extension': patch
---

cNIGHT registration on Cardano mainnet now goes to the contract the Midnight
bridge watches.

`cnight_generates_dust` compiles the cNIGHT policy in, so mainnet has its own
script: hash 73e4aea3…, address
`addr1w9e7ft4rrdd4rkdseguxr9hudfxyytm5ckh2qy0yhz7lfeg9lvhq7`. moth attached
the testnet script (7e69087d…) on every network, so a mainnet `register`
locked its NFT at `addr1w9lxjzranravtp574s2wz00md7vz9rzpucu252je68u9a8qe6r9ud`,
an address the bridge does not read: Cardano confirmed it and no DUST was
ever generated. `status`, `update` and `deregister` looked at the same wrong
address.

Each Cardano network now selects its own deployment, both pinned from
midnight-reserve-contracts' `deployed-scripts`. Preprod and Preview are
unchanged. `scripts/sync-cnight-blueprint.mjs` takes `--deployment
mainnet|testnet` and pins each hash separately.
