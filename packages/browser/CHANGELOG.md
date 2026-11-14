# @shieldedtech/moth-browser

## 0.15.0

### Minor Changes

- cabe681: Use what `@midnight-ntwrk/dapp-connector-api` 4.1.0 added: the
  `InsufficientFunds` error code and `Signature.scheme`. The extension now
  advertises `apiVersion` 4.1.0.

  A connector request the wallet cannot fund now rejects with
  `InsufficientFunds` instead of `InternalError`. That covers
  `balanceSealedTransaction`, `balanceUnsealedTransaction`, `makeTransfer` and
  `makeIntent`, whether the shortfall is a shielded or unshielded token or the
  DUST fee. The connector recognises the wallet SDK's error by its tag
  (`Wallet.InsufficientFunds`), which survives the trip out of the offscreen
  worker where the error's class does not. A malformed request is still
  `InvalidRequest`, and every other failure keeps the code it had.

  The reason now names the token and the shortfall, as
  `Insufficient funds [tokenType=…, amount=…]`, which it was meant to do already
  and did not. The SDK's promise methods reject with Effect's `FiberFailure`,
  whose only own field is its name. The SDK error, with its `_tag`, `tokenType`
  and `amount`, sits behind a symbol, so the fields were dropped at the first hop
  and the dApp received the bare message. The worker's error codec now hands on
  the typed failure inside a `FiberFailure`. A defect has none, and stays
  wrapped. The extension's own screens see the same errors with the
  `(FiberFailure) ` prefix gone from their names. Their messages are unchanged.

  `signData` results carry `scheme: 'schnorr_bip340'`. In core, `SignedMessage`
  gains a `scheme` field, read off the ledger's signature tag, and core exports
  the `SignatureScheme` type. The signature and key are unchanged: a 64-byte r‖s
  signature and a 32-byte x-only verifying key, the formats 4.1.0 specifies for
  that scheme. moth signs only with schnorr. An ECDSA signature would be named
  `ecdsa_secp256k1_sha256`.
- 5ce169b: From the v9 fork on, the DUST wallet syncs from the indexer's DUST projections
  instead of replaying every DUST ledger event, so its sync scales with the
  wallet's own activity rather than the chain's length.

  Below the fork nothing changes: ledger-v8 has no projections path, so the wallet
  replays events as before, and at the fork it hands its state over to the
  projections side. After the fork, each sync pass runs every 5 seconds rather
  than following a live subscription, and a restart resumes from the block height
  the saved state reached.

  Pre-seeding no longer records a cursor witness for a DUST reference the
  projections sync wrote. Its offset is a block height rather than an event id,
  so an indexer renumbering cannot misplace it.
- 58b2553: Add `local`, midnight-node's local-env (`ws://localhost:9933`), as a network of its own. It is no
  longer folded into `undeployed`: local-env's network id reaches its addresses (`mn_addr_local1…`),
  so serving it as `undeployed` derived the wrong prefix and read every unshielded balance as zero.
  Stored `local` selections, wallets, birthdays and endpoint overrides now stay on `local`.

  - `--network local` now targets 9933. Scripts that used it as an alias for the 9944 dev stack must
    switch to `--network undeployed`.
  - Wallets that 0.13.0–0.14.1 already rewrote to `undeployed` stay there: select Local again, or
    recreate the wallet.
- fa2a009: Upgrade to `@midnightntwrk/wallet-sdk` 2.0.0, which brings `@midnightntwrk/ledger-v9` 1.0.0, and to
  `@midnight-ntwrk/midnight-js` 5.0.0. The SDK runs ledger-v8 below the chain's v9 fork and ledger-v9 from it, and its
  wallets follow a live chain across the boundary, so moth reaches networks on either side with one
  build.

  - Wallets start from per-role seeds: `WalletKeys` is now `{shielded, unshielded, dust}` seeds
    rather than ledger key objects, and the wallet holds the keys it derives from them for as long
    as it runs. Transaction-building methods no longer take key material.
  - Transactions travel as version-stamped handles (`FinalizedTransaction`). Hex payloads on the
    daemon socket and dApp-supplied transactions are read with the ledger the facade is acting at,
    through the SDK's `WalletFacade.adoptTransaction`; `transactionHashOf` and
    `activeProtocolVersion` read hashes and versions off the handles.
  - Proving routes by protocol version: one proof server serves both sides, and the in-process
    prover, including the extension's in-worker one, is registered per ledger version. Each backend
    refuses a transaction built by the other ledger version with `ProvingEpochMismatchError`.
  - ledger-v8 now comes from `@midnightntwrk/ledger-v8` 8.1.3, the copy the SDK and midnight-js 5 both use, and the
    in-process prover from `@midnightntwrk/zkir-v2` 2.2.0, the one the SDK proves with. The `@midnight-ntwrk` copies
    are gone from the install: a second copy of a WASM ledger refuses the first one's objects.
  - The client-side dedup of re-sent boundary events (`sync/sdk-dedup.ts`) is removed; the fix
    landed upstream in both wallet variants.
  - DUST fee balancing keeps largest-first coin selection and moth's own balancing loop on both
    sides of the fork, through `DustWallet` rebuilt with `CustomForkingDustWallet` over the SDK's
    `dustVariantConfigurations`, so each variant is valued against the same rates. SDK 2.0.0-rc.1
    fixed the unbounded loop upstream; moth's stays because it reports each pass to the fee log.
  - A DUST fee is no longer dated at a block whose DUST events the wallet has not applied, which the
    node rejected with `Custom error: 170`. When neither the newest block nor the wallet's own is safe
    to date it at, balancing re-reads the newest block every second and fails with `SyncWalletError`
    after two minutes.
  - A wallet restored from a cache written below the v9 fork is started by the facade with both
    ledger versions' keys, derived from the seeds, so it resumes on whichever side its cache was
    written.
  - Contract deploy, call and maintenance run on midnight-js 5 and work on both sides of the v9 fork. An
    artifact's compact-runtime version picks its ledger. One compiled by compactc 0.31 (runtime 0.16) is a
    ledger-8 contract: it deploys and takes maintenance updates
    before the fork, and stays callable after it. One compiled by compactc 0.36.0 (runtime 0.21) is a ledger-9
    contract, which runs from the fork on; the proof server (9.0.0 or later) and the in-process prover both
    prove its ZKIR v3 circuits. Artifacts compiled for any other runtime are refused.
  - A contract project that has its own midnight-js runs the whole operation on that copy, so it must be on
    midnight-js 5 and have the node-zk-config, indexer, level private state and http-client proof provider
    packages. A project still on midnight-js 4 is refused with a message saying so.
  - Contract artifacts are checked against `compiler/contract-manifest.json` when they carry one, as compactc
    0.36 writes it.
  - The intent the wallet adds while balancing a contract transaction lives for one hour, the lifetime
    midnight-js gives the transaction itself, where it was 30 minutes.
  - `createProofProvider(config, zkConfigProvider)` takes the contract's `ZKConfigProvider` rather than a key
    material provider, and returns a midnight-js 5 proof provider that serves both ledger eras.
  - Message signing returns the schnorr hex value of ledger-v9's tagged signature, so the wire
    format is unchanged for connectors.
  - Browser bundles now carry both ledgers' WASM, as every SDK 2.0 consumer does.
  - The wait for the first facade emission no longer reaches for its own subscription: the 2.0
    facade replays state synchronously on subscribe, which turned that into a startup crash.
  - The SDK's unshielded subscription now reads `protocolVersion` off the indexer's progress frame,
    so unshielded sync needs an indexer that exposes it (midnight-indexer 4.4.0-rc.2 / `25da0487`
    or later). Against an older indexer the unshielded wallet never connects.
  - The unshielded wallet no longer takes the indexer's word that it is synced: it checks the
    indexer's tip against the node's finalized head, and its sync completes only once that check does
    not block. Against an indexer that is behind the node, or on another network, unshielded sync
    stays incomplete, and so do the NIGHT and DUST operations that wait for it.
  - After a send or a DUST registration on a quiet wallet, unshielded sync reports complete within
    seconds, where it could stay incomplete for up to about five minutes, waiting for the indexer's
    next progress message. The NIGHT and DUST operations that wait for it no longer stall.
  - A UTXO booked for a transaction that was never submitted is released once its TTL passes, and a
    resync no longer re-admits a booked UTXO as available, which could double the NIGHT balance.
  - Shielded coins booked for a transaction that is never submitted or never included are released
    during sync, once the lesser of its TTL and 14 days has passed. A send or balance that fails
    part-way releases the coins it had already booked.
  - Each transaction in flight is one SDK lifecycle record, from balancing to the chain's verdict,
    saved with the wallet under the same cache key; the pending list an earlier build saved is read
    back as records. A record that ends rejected or orphaned releases its coins, as before.
  - A transaction the chain applies only in part releases only the coins of its failed segments;
    what its guaranteed and successful segments spent stays spent. Reverting a transaction releases
    only the DUST it spent, and pending DUST is saved with the wallet, so a restored wallet can still
    release it.
  - Stopping a wallet whose node never answered now completes: the SDK's submission service
    abandons its unfinished connection on close, and nothing it started keeps retrying. The
    5-second bound on teardown, and its "Sync stop timed out" message, are gone.
  - A call to the node after an idle gap, such as a send, no longer waits a second and logs
    `WebSocket is not connected` before it is served.
  - A wallet restored from cache reports the protocol version its state records, rather than its
    variant's lower bound, so the protocol version shown in Settings and stamped on the transactions
    it builds is right from the first state after a restart.
  - Cached wallet state and transaction history are written in the SDK's versioned formats. A
    pre-seeded snapshot, which carries no format version, still restores as the legacy format.
    Fields a newer build wrote are kept on the next save. DUST snapshots and the lifecycle records
    are written in new format versions that earlier builds refuse, so after a rollback the DUST
    wallet resyncs from genesis and the records of transactions in flight are dropped.
- ab76749: Prove compactc 0.36 (ledger-9) contract circuits in process, with `@midnightntwrk/zkir-v3` 3.2.0.

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

### Patch Changes

- 6eeba08: Keep the DUST capacity steady while a submitted transaction lands.

  The capacity was read off the dust sub-wallet's available coins. Submitting a
  transaction moves the coin it spends out of that list at once, so the meter
  fell to "of 0 · not registered yet"; when the spend landed, the old coin's
  remainder kept its full cap while it decayed next to the fresh coin for the
  change UTXO, so the meter doubled; and the dust and unshielded sub-wallets
  apply the same transaction at different moments, so it settled only after
  both had caught up.

  The capacity is now derived from the registered NIGHT UTXOs, counting the
  inputs booked by an in-flight transaction the way the NIGHT balance already
  does, and dust coins whose backing NIGHT was spent no longer count toward it.
  The arithmetic lives in `sync/dust-generation.ts`, which is unit-tested
  without WASM.
- 891e7f3: Hold the DUST balance steady while a fee is in flight, tell the truth about
  when DUST fills, and log the fee a send actually pays.

  Paying a fee moves the whole DUST coin out of the ledger's spendable set until
  the transaction lands, and the change only arrives with the chain event, so the
  displayed balance fell by the size of the coin rather than the size of the fee:
  12,959.88 to 9,354.74 and back on a preprod send. With largest-coin-first
  selection that is the largest drop available. Booked coins now count toward the
  balance, as booked NIGHT inputs already did.

  The fill-time estimate came from the SDK's `maxCapReachedAt`, which is the
  coin's creation time plus the whole time-to-cap however full the coin already
  is. Every spend gives the change coin a fresh creation time, so a wallet at 39%
  was told "full in about 7 days" after each send. The meter's estimate now comes
  from the meter: the fraction of the climb still ahead, at the rate the whole
  registered balance generates. That wallet reads about 4 days. Reading the
  slowest individual coin instead would not have helped, because every send
  leaves a fresh change UTXO whose own coin starts low, pinning the estimate near
  the full climb for any wallet in use.

  The TUI shows a countdown per coin, where the remaining climb over that coin's
  rate is the right answer, so `DustCoinInfo` now carries the coin's rate and the
  shared `secondsUntilFull` replaces `maxCapReachedAt` there.

  `startWalletSync` takes an `onDustFeePass` callback carrying each pass of the
  DUST fee-balancing loop, and the extension logs it alongside the quote the
  confirm screen shows. The preview and the real spend share the SDK's balancing
  recipe, so both appear, which is what makes a quote that disagrees with the
  spend visible without querying the chain.
- fd3366a: Run local (WASM) proofs in parallel, and show that proving is happening.

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
- Updated dependencies [8fcbeaa]
- Updated dependencies [e38ea20]
- Updated dependencies [b3ca358]
- Updated dependencies [cabe681]
- Updated dependencies [c59cb7e]
- Updated dependencies [773443b]
- Updated dependencies [6eeba08]
- Updated dependencies [891e7f3]
- Updated dependencies [5ce169b]
- Updated dependencies [58b2553]
- Updated dependencies [5aff21e]
- Updated dependencies [d07668a]
- Updated dependencies [fd3366a]
- Updated dependencies [b57f3e9]
- Updated dependencies [e3f8a35]
- Updated dependencies [7519c11]
- Updated dependencies [844ee29]
- Updated dependencies [78300a1]
- Updated dependencies [8f1356e]
- Updated dependencies [fd3366a]
- Updated dependencies [fa2a009]
- Updated dependencies [ab76749]
  - @shieldedtech/moth-wallet@0.15.0

## 0.14.1

### Patch Changes

- Updated dependencies [0f0afa3]
  - @shieldedtech/moth-wallet@0.14.1

## 0.14.0

### Patch Changes

- Updated dependencies [3b39fb6]
- Updated dependencies [3b39fb6]
- Updated dependencies [3b39fb6]
- Updated dependencies [55a878c]
- Updated dependencies [77edf22]
- Updated dependencies [aa3c276]
- Updated dependencies [19a1a23]
  - @shieldedtech/moth-wallet@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [a17b719]
- Updated dependencies [b49c96d]
- Updated dependencies [f736ebd]
- Updated dependencies [b49c96d]
- Updated dependencies [0508a38]
- Updated dependencies [2dabc50]
- Updated dependencies [426b757]
- Updated dependencies [eb4d56a]
- Updated dependencies [3e131e2]
- Updated dependencies [9afd580]
- Updated dependencies [b49c96d]
- Updated dependencies [e31eaf8]
- Updated dependencies [c2f8b73]
- Updated dependencies [b49c96d]
- Updated dependencies [b49c96d]
- Updated dependencies [b49c96d]
- Updated dependencies [c1c462e]
- Updated dependencies [9be5669]
- Updated dependencies [ea1793d]
- Updated dependencies [316ca82]
- Updated dependencies [89f34aa]
- Updated dependencies [04f1aa4]
  - @shieldedtech/moth-wallet@0.13.0

## 0.12.1

### Patch Changes

- @shieldedtech/moth-wallet@0.12.1

## 0.12.0

### Minor Changes

- ea15676: Coordinate the first public package release under the Moth package names.

  This is a minor bump because no package has previously been published under the
  new names. The release remains experimental and unsupported, so it stays below
  1.0.0. Package names, CLI identifiers, environment variables, connector identity,
  and local state paths are aligned before publication; no compatibility shim is
  required for an unpublished package.

### Patch Changes

- Updated dependencies [be98f55]
- Updated dependencies [ea15676]
  - @shieldedtech/moth-wallet@0.12.0

## 0.1.1

### Patch Changes

- 771338d: Tell the user when registration needs time, instead of failing and blaming the
  proof server.

  Registering NIGHT for DUST generation is self-funding: a `DustRegistration`
  carries `allow_fee_payment`, and the ledger lets the transaction pay its own fee
  from the DUST its NIGHT _would have_ generated had it been registered all along.
  That is what stops the obvious deadlock — DUST pays fees, and registering is how
  you get DUST.

  Self-funding is not free. `generationless_fee_availability` caps the backdated
  amount at `elapsed × night_value × generation_decay_rate`, which starts at zero.
  So a freshly funded wallet cannot cover the fee yet, and the wait is _inversely
  proportional to the balance_: at the ledger's defaults a 0.3 DUST fee needs ~36s
  at 1,000 NIGHT, ~6 min at 100, ~1 hour at 10, and ~10 hours at 1.

  Reported from preprod as a red failure card reading "That didn't go through",
  with the raw SDK message and a footnote suggesting the proof server. Two of those
  three were wrong: nothing went wrong, and proving never happened — the SDK refuses
  before building.

  `estimateRegistrationAffordability` (core, pure, WASM-free) turns the SDK's
  per-UTxO figures into an answer: affordable now, affordable in N seconds, or never
  at this holding. That last case matters — when the ceiling is below the fee,
  "wait" is the wrong advice and "hold more NIGHT" is the right one.

  `designateForDust` throws `DustRegistrationNotYetError` carrying that estimate.
  Because the guard sits in core, it reaches every run mode at once — extension,
  CLI, TUI and daemon RPC all route through the same function.

  Two decisions worth recording. The estimate is computed only on the failure path,
  so a registration that was always going to succeed pays nothing for it. And
  whether to raise the typed error is decided by the affordability numbers, not by
  matching the SDK's message text — string-matching would need re-matching on every
  SDK release, and would fail silently when it drifted.

  The panel now shows "Not quite yet", says nothing was spent, and gives a localized
  wait ("Ready in about 8 hours"). `mayBeProvingFailure` suppresses the proof-server
  footnote for every outcome decided before proving.

  `moth dust register` gains a pre-flight and `--wait` (with `--wait-timeout`). The
  pre-flight matters more on the CLI than in the panel: without it the only way to
  learn the wait is to fail, and re-running means paying for a full sync first.
  `--wait` polls rather than sleeping the predicted duration blind, since the
  estimate moves if the wallet's NIGHT changes underneath it.

  Also corrects the documentation. Four files stated that the ledger imposes a 3h
  grace period before DUST appears. `dust_grace_period` is 3 hours, but it bounds how
  stale a transaction's declared `ctime` may be — it is not a delay before
  generation starts, which is linear from the UTxO's creation with a time-to-cap of
  about a week. The observation behind the claim was real; the mechanism was
  invented to fit it. The guides are corrected in place; ADR 0003 is annotated
  rather than rewritten, since it is a dated record of what was decided.

- 73d26e1: Add an opt-in "Speed up new accounts" setting that prepares the pre-seed reference.

  Wires `warmEmptyRefCache` and `preseedReferenceStatus` through the offscreen host,
  messaging, dispatch, client and protocol layers, and re-exports them from the
  browser package. Building a network's reference to chain tip is what lets accounts
  created afterwards start there instead of walking the chain — measured on preprod
  as 78.6 min of dust sync becoming ~49s.

  Surfaced under Settings → Network with three states rather than a bare toggle,
  because the build takes about an hour and "in progress" forever is
  indistinguishable from stuck:

  - `Off` — not started (the default)
  - `Preparing 34%` — building, from the reference's dust applied/total
  - `Ready` — a static badge, since there is nothing left to toggle once the work
    is banked

  Progress is polled via `preseedStatus` every 5s while enabled and not yet ready,
  rather than pushed as a new port event: fewer moving parts for a number that
  changes slowly. The percentage caps at 99% so it cannot sit at 100% during the
  minutes between the last dust event and the reference being serialized and
  verified — `Ready` is driven by the store's usability gate, not by arithmetic.

  Two deliberate departures from how the other long operations are wired:

  - Not bracketed in `beginOp`/`endOp`. Every transaction op is, but this runs for
    tens of minutes and holding the wallet open that long would defeat the idle
    teardown that drops key material from memory. The build is expected to be
    interrupted and resumes from partial state on the next unlock, so progress
    accumulates across sessions.
  - No unlocked session required. The reference is an unfunded throwaway wallet with
    its own keys, so warming needs neither the user's seed nor an unlocked wallet.

  Off by default: an hour of background chain traffic per network should be a
  deliberate choice. Only accounts created AFTER the reference completes benefit —
  older ones are refused by the birthday guard and take the slow path, which is the
  guard working rather than the feature failing.

- Updated dependencies [fc93b31]
- Updated dependencies [fc93b31]
- Updated dependencies [12881a3]
- Updated dependencies [b157dd2]
- Updated dependencies [c7d1ef7]
- Updated dependencies [36cb067]
- Updated dependencies [fc93b31]
- Updated dependencies [6f914fc]
- Updated dependencies [fc93b31]
- Updated dependencies [fc93b31]
- Updated dependencies [771338d]
- Updated dependencies [fc93b31]
- Updated dependencies [ba86b72]
- Updated dependencies [fc93b31]
- Updated dependencies [b7e2f00]
- Updated dependencies [1c597ff]
- Updated dependencies [24cb16c]
- Updated dependencies [0f9369f]
- Updated dependencies [bf49ced]
- Updated dependencies [0f197e2]
- Updated dependencies [1f69f66]
- Updated dependencies [fc93b31]
- Updated dependencies [6766583]
- Updated dependencies [fc93b31]
- Updated dependencies [2fde86f]
  - @shieldedtech/moth-wallet@0.2.0
