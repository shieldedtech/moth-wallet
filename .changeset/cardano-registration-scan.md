---
'@shieldedtech/moth-wallet': patch
---

Find a Cardano DUST registration in seconds instead of minutes on mainnet.

Every registration on the network sits at the same validator address with the
same auth NFT, so finding this wallet's one means reading all of them: over
4,000 on mainnet. Lucid's Blockfrost provider fetched them one page at a time
and then slept 500 ms for every ten while converting them, which added about
six and a half minutes to every `cardano status`, `register`, `deregister`,
`update` and cNIGHT `send`, and grew with every new registration.

The registrations are now read straight from Blockfrost, eight pages at a
time, with a short back-off if Blockfrost rate-limits the scan. A mainnet
lookup is about 50 requests and no deliberate waiting.
