---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-extension': patch
---

Bound the sync-engine teardown, and stop a wedged one from pinning everything
behind it.

`facade.stop()` closes the wallet SDK's submission service, which first awaits
the Polkadot client the facade was built with. That client is created with
`ApiPromise.create({throwOnConnect: false})`, so against a node that never
answers it neither resolves nor rejects — WsProvider simply keeps retrying. The
stop therefore had no failure path, and every caller inherited the hang. The
trigger is a node URL that does not answer, which is exactly the state a user is
in while editing one, Local network being the common case.

Three consequences, all fixed here:

- **Settings → Network's Save button spun for ever and discarded the edit.**
  `saveNetworkConfig` awaited the stop before persisting, so the save neither
  completed nor failed and the next attempt started from the same broken
  endpoint. Settings are now written before the engine is touched and rolled back
  if the switch fails, and a stop the offscreen document never answers closes that
  document — Chrome destroys it without its cooperation, which is the only
  teardown that reaches a wedged one.
- **The idle teardown never closed the offscreen document,** so an idle wallet
  kept its worker and WASM heap alive instead of letting the service worker
  suspend.
- **Locking never freed the worker holding key material,** because `lockNow`'s
  forced teardown waited on the same stop.

`facade.stop()` is now raced against a 5s bound. The offscreen `syncStop` no
longer waits unboundedly on a start that may never finish, and still stops that
engine whenever it does come up, so an abandoned start cannot keep syncing behind
a new one.
