---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-extension': patch
---

A send whose proof stalls or fails no longer leaves the wallet unable to send.

In the extension, a local (WASM) proof that stalled kept the send on
"Generating proof" indefinitely, and every later send and fee estimate queued
behind it. Each proof job now fails after 5 minutes without a result, and a key
or parameter lookup after 2 minutes, with an error naming what it was waiting
on; the stalled worker is terminated and the queue moves on. Each job logs its
lookups and duration under `[moth proof]`.

Building a transaction books the coins it spends, the fee's DUST included, and
a transaction that was never proved was never submitted, so nothing released
them: they were saved with the sync cache, survived a reload, and the next send
waited on "Waiting for previous transaction" for a transaction that would never
confirm. When signing or proving fails, the wallet now reverts the transaction
and releases its coins. This covers transfers, swaps, dApp and contract
transactions, and DUST registration and deregistration.
