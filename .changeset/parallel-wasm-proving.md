---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-browser': patch
'@shieldedtech/moth-extension': minor
---

Run local (WASM) proofs in parallel, and show that proving is happening.

**Why a transfer took two to three minutes to prove.** The ledger asks for every
proof in a transaction at once — measured: all of `Transaction.prove`'s
`provider.prove` calls start within 2 ms of each other — but the extension ran
them through zkir's in-thread prover on the single wallet-worker thread, where
they can only execute one after another. Each zswap proof is ~25 s of
single-threaded WASM (measured on a Ryzen 9 8945HS: one output proof 25.7 s,
two 46.8 s), so a plain transfer's spend, output(s), signature and dust proofs
summed to the ~160 s users saw, against ~10 s for a proof server. The key
material download is not the cost: ~9 MB in 4.5 s, once per worker lifetime.

**Fix.** Core's `proof/provider.ts` gains `setWasmProvingProviderFactory`, the
seam through which a host with threads to spare supplies its own local prover.
The extension installs a pool of proof workers (`lib/offscreen/proof-pool.ts`,
`proof-worker.ts`): each requested proof runs on its own worker, so a
transaction's proofs overlap and finish in about the time of the slowest one.
Key material stays in the wallet worker — one fetch and one in-memory copy of
the ~30 MB of prover keys and params, however many proof workers ask for it.
Workers spawn on demand up to `min(4, cores − 1)` and are retired after 30 s
idle so their WASM heaps do not outlive the transaction. Node hosts (CLI, TUI,
daemon) keep the default; under `wxt dev` the inline host keeps the in-thread
prover, since its cross-origin dev server cannot load the worker.

**Showing that it is working.** A proof that runs for minutes behind a frozen
"Generating proof" line is indistinguishable from a hung wallet. The send and
DUST pending screens now carry a note for local proving — where it runs, that a
few minutes is normal, that details never leave the browser — with the moth
beating its wings and a clock counting up beside it, and their hero line no
longer promises "under a minute" when the prover is WASM. Home gains the same
note as a banner for work with no screen of its own: a dApp's transaction after
its approval closes, or a send whose screen was left. To make that possible the
background now keeps the stage in progress with its start time, replays it to
each newly-connected panel, and clears it when the last op ends (the offscreen
host only ever reported stage starts). The `txStage` port event carries `since`
and may now be `null`.
