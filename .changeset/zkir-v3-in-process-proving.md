---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-browser': minor
'@shieldedtech/moth-extension': minor
---

Prove compactc 0.36 (ledger-9) contract circuits in process, with `@midnightntwrk/zkir-v3` 3.2.0.

compactc 0.36 emits circuits as ZKIR v3 only, which zkir-v2 cannot read. The local (WASM) prover
now hands each circuit to the zkir that reads it, picked by the header of the circuit's IR:
`midnight:ir-source[v3-generic]:` goes to zkir-v3, and anything else to zkir-v2 as before. The
circuit decides, not the transaction: a compactc 0.31 contract called after the v9 fork puts
ZKIR v2 circuits in a ledger-9 transaction, and those stay on zkir-v2.

- Contract deploy, call and maintenance run with the in-process prover for ledger-9 contracts
  too, so they no longer need a proof server.
- In-process contract proofs resolve the key locations midnight-js 5 gives a contract's
  circuits, `contract:<address>/<circuit>?vk=<hash>`, through midnight-js's verifier-key join,
  as its proof-server client does.
- The extension's dApp connector (`getProvingProvider`) proves a dApp's ZKIR v3 circuits in WASM
  mode. Its proof workers load zkir-v3 only when they are handed a ZKIR v3 circuit. The page no
  longer asks a dApp for the keys of the ledger's own circuits (`midnight/...`), which a
  midnight-js 5 dApp's key provider refuses; the wallet supplies those itself.
- With a proof server, `createProvingProvider` (and so the dApp connector) proves a midnight-js 5
  dApp's contract circuits: midnight-js's proof-server client asks for a `contract:` location's
  keys by its bare circuit id, which is now answered from the keys served for that location.
- The wallet's own circuits (zswap and dust) are ZKIR v2 for both ledger versions, and stay on
  zkir-v2.
- In the browser, the wallet proves a ledger-v8 transaction with ledger-v8's key material
  (circuit generation 9) and a ledger-v9 one with ledger-v9's (generation 10). Both used
  generation 10, so a DUST fee proved locally before the fork would have been rejected.
- `WasmProvingProviderFactory` takes the circuit's ZKIR version as a second argument, and
  `zkirVersionOf` and `ZkirVersion` are exported. `ProofProviderKit` also carries midnight-js's
  `ZKConfigRegistry` and `parseContractKeyLocation`.
- zkir-v3's WASM adds 4.06 MB to the unpacked extension, 1.12 MB zipped.
