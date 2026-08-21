---
'@shieldedtech/moth-wallet': minor
---

Add the wallet-SDK seam, so the SDK generation follows the active ledger.

`wallet-sdk@1.2.0` binds to ledger-v8 and rejects a v9 ledger object at the WASM
boundary. The v9 line is installed under an npm alias so both generations
coexist. `initSdk(version)` loads the matching pair — SDK and ledger together —
and `sdk()` serves it synchronously.

`createKeystoreFor` normalises the one call whose shape changed across the fork:
v8 takes the raw secret, v9 takes `{kind, secret}` where kind selects Schnorr or
ECDSA.

`/hd` and `/address-format` are measured fork-invariant and keep direct imports.
