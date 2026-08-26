---
'@shieldedtech/moth-wallet': patch
---

Stop the sync before freeing the keys when the TUI quits.

Quitting printed a wall of WASM errors over the exiting terminal, once per live
sync:

```
Wallet.Other: Error while applying sync update
  cause: Error: Dust secret key was cleared
    at DustLocalState.replayEventsWithChanges
```

The quit handler called `lockAll()` and then `exit()`, zeroing the
`DustSecretKey` in the WASM heap while the dust sync was still mid-batch. The
only `stop()` lived in an unmount cleanup, ran after `exit()`, and was
fire-and-forget, so the sync's next batch reached for a key that no longer
existed.

`useBalance` now exposes an awaited `stop()` — unsubscribe, await the facade's
stop, bounded by a timeout so a sync that will not settle cannot keep the TUI
open — and both quit paths await it before locking.

Nothing was corrupted: the wallet was exiting and its state was already
persisted. It simply looked like a crash every time, and would have buried a real
error.

The non-quit unmount path (Ctrl-C, a crash, the process ending) now stops before
locking as well, which narrows the window rather than closing it — a React
cleanup cannot await, so a batch already inside the WASM call can still find the
key gone.
