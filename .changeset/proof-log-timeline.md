---
"@shieldedtech/moth-extension": patch
"@shieldedtech/moth-wallet": patch
---

Record proof-pool diagnostics in the timings log. The log showed only stage changes, so a proof that hung after "tx: proving" left nothing to go on without opening the offscreen console. Each proof job's start, every key and parameter lookup with how long it took, its finish, and a timeout naming what it was waiting on now appear in the debug page under a new `proof` source. The core `TimingSource` type gains `'proof'`.
