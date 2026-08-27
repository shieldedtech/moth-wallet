---
'@shieldedtech/moth-wallet': minor
---

Add the ledger seam, so v8 and v9 can both be live in one process.

`initLedger(version)` loads a ledger's WASM module and makes it current;
`ledger()` and `ledgerFor(version)` then serve it synchronously, which is what
key derivation needs — it cannot await. Both generations can be held at once,
at distinct class identity, so a value from one is never mistaken for the
other.

Loading is deliberately lazy rather than a pair of static imports: the two
modules are ~10MB of WASM each, and a wallet only needs the one its network
speaks.
