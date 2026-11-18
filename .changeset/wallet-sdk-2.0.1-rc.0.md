---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-tui': patch
---

Move to the release candidates `@midnightntwrk/wallet-sdk` 2.0.1-rc.0 and
`@midnight-ntwrk/midnight-js` 5.0.1-rc.1, with `@midnightntwrk/ledger-v9` 1.0.2-rc.0,
`@midnightntwrk/onchain-runtime-v4` 4.0.2-rc.0, `@midnight-ntwrk/compact-js` 3.0.1-rc.2 and
`@midnightntwrk/zkir-v3` 3.2.1. `@midnightntwrk/ledger-v8` stays at 8.1.3 and
`@midnightntwrk/zkir-v2` at 2.2.0, the versions both libraries still build on.

- A failed submission keeps the transaction's coins and DUST booked unless the failure proves no
  block holds it, so a finality timeout after inclusion no longer offers spent coins until sync
  catches up.
- Proving through a proof server keeps at most 10 requests waiting there and resends on a full
  queue (HTTP 429) and on 502, 503 and 504, so a transaction with many proofs no longer fails
  with `Job Queue full`.
- A shielded wallet on a chain with no shielded outputs yet reports synced.
- A DUST wallet on projections sync keeps syncing when a pass returns a coin it already applied,
  and a DUST snapshot holding values the wallet cannot use is refused rather than restored.
