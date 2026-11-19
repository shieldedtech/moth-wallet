---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-extension': patch
---

The activity feed now tracks what a wallet spends. A transaction whose only
trace in the wallet is the DUST that paid its fee (a contract call, typically)
reads "Network fee paid"; it used to read "DUST registration" with DUST gained
whenever the change UTXO's initial value exceeded the spent one's, which is
most of the time, since that comparison misses the DUST generated in between.
DUST rows show no amount: neither that difference nor the indexer's reported
fee is a real figure. DUST that only arrives — generation starting, or
restarting at a protocol upgrade — is no longer listed. Activity entries gain
`paidFee`. The iOS app titles DUST rows the same way and drops its fee line.
