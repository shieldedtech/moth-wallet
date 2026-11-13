---
'@shieldedtech/moth-extension': patch
---

Prove dApp transactions off the sync lane, with a bound.

A dApp's proving request (the connector's `getProvingProvider` path) could be
held for minutes and then answered together with later requests. The proof was
dispatched on the wallet worker that owns the sync engine, whose thread a cold
start blocks while it restores the account's sync caches; the requests queued
behind that restore and were all proved when it finished, by which time the
transactions were too old for the chain to accept. Proof requests now run on
the second worker instance; they carry their own key material and use the
network's prover, so they never needed the sync session. A proof the worker
does not answer within six minutes fails with a clear error instead of waiting
out the page's ten-minute timeout.
