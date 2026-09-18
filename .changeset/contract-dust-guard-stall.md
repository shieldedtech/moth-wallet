---
'@shieldedtech/moth-wallet': patch
---

Stop waiting for two equal DUST balances before building a contract transaction.

Before building a contract transaction the contract paths waited for the wallet
to be strictly synced, and then for two consecutive emissions carrying an
identical DUST balance. `facade.state()` emits roughly every 30 seconds, and a
resident daemon has just spent DUST on the previous call, so the pair never
matched on the first try and every call after the first paid a full emission
cycle.

Measured with the wait instrumented, this was 39 s of a 60 s daemon call on a
local stack and 16-30 s of a ~36 s call on preprod, against 1.7 s of real work.
Comparing both snapshots at a single instant does not help, because the balance
genuinely differs after a spend.

The pair check is removed. The strict-completion filter stays: that is what
guards against a stale dust tree root (InvalidDustSpendProof, error 170), and it
is all the transfer path has ever done. Per call this takes preprod from ~36 s
to ~27 s and a local stack from 60 s to ~29 s.
