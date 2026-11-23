---
"@shieldedtech/moth-extension": patch
"@shieldedtech/moth-wallet": patch
---

Cardano screen: show the account address as soon as it is derived, then ADA and cNIGHT balances from a quick read of the wallet's own UTXOs, then the DUST registration. A status read that gives no answer within 2 minutes now ends in an error with a retry instead of a spinner that never stops.

Reading DUST registrations no longer takes minutes on mainnet. Lucid's Blockfrost provider pauses 0.5 s every 10 UTXOs and 5 s every 100 while converting results, which across the 4,000+ registrations at the mainnet validator came to over six minutes on every status read, register, update and deregister. The registration pages are now read directly, a few at a time, and decoded from the response; only this wallet's matches go through Lucid.
