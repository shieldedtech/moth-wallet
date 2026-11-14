# @shieldedtech/moth-cli

## 0.15.0

### Minor Changes

- 8fcbeaa: The bundled moth-ft token issuer, and the receive-unshielded test fixture, now come in two builds:
  the compactc 0.31.1 one they had (a ledger-8 contract) and a compactc 0.36.0 one (a ledger-9 contract).
  midnight-js 5 refuses to deploy a ledger-8 contract after the v9 fork, and attaches to a deployed
  contract only through the build whose verifier keys it holds, so moth picks one per operation.

  - `deployFungibleToken` deploys the build for the era of the network's latest block, the reading
    midnight-js checks a deploy against. Token deploys from the CLI and TUI keep working after the fork.
  - `mintFungibleToken` reads the contract's state and mints through the build whose verifier keys it
    holds: the ledger-8 build for a token deployed before the fork, on either side of it, and the
    ledger-9 build for one deployed after. An address that holds neither build's keys is refused with a
    message saying so.
  - A ledger-9 build's circuits are ZKIR v3, so minting through it needs a prover that reads them, such
    as proof server 9.0.0 or later.
  - The package now ships moth-ft (both builds, about 16.7 MB packed). It shipped only `dist` before,
    so `deployFungibleToken` and `mintFungibleToken` found no artifact outside this repository.
  - Core depends on `@midnight-ntwrk/compact-runtime` 0.21.0, shared with midnight-js, and on 0.16.0
    under the alias `compact-runtime-ledger8`, the name midnight-js gives its own ledger-8 copy. The
    ledger-8 modules import the alias, so each build resolves its own runtime in any install.
  - `FUNGIBLE_TOKEN_ARTIFACT_DIR` is removed. `bundledContractBuild(name, era)`,
    `bundledContractForDeploy(name, network)` and `bundledContractForAddress(name, address, network)`
    give a bundled contract's build directory, and the build an operation should take.
- e38ea20: Register cNIGHT on Cardano for DUST generation, from all four surfaces.

  DUST can be generated from NIGHT held on Midnight or from cNIGHT held on
  Cardano. moth only did the first. The second needs a Cardano transaction that
  maps a Cardano stake key to a Midnight DUST address, so it needed Cardano
  keys, the `cnight_generates_dust` Plutus validator and a chain provider — none
  of which the wallet had.

  Core gains a `@shieldedtech/moth-wallet/cardano` subpath with register,
  deregister and change-receiver, reachable as `moth cardano …`, `moth daemon
  cardano …`, the TUI's `a` screen and a Cardano screen in the extension.

  Cardano keys come from the account's existing recovery phrase via CIP-1852, so
  there is no Cardano account to create and nothing new to back up — every surface
  now says so where the address is shown, because "where do I create one?" is the
  first thing the absence of a create button suggests.

  The Cardano address is shown before anything is configured, since funding it is
  the first step and derivation needs no Blockfrost key. The extension reaches
  Cardano from the home screen rather than only from Settings, and truncates
  addresses with a copy button rather than laying a 103-character bech32 string
  into a label/value row.

  Multiple Cardano accounts, in the extension. "Add account" takes the next
  CIP-1852 index of the wallet's own phrase — its own address, its own stake key
  and so its own independent DUST registration, with nothing new to back up.
  Indices come from a persisted high-water mark, never recomputed from the list,
  so removing an account cannot hand its address and registration to the next one
  created. "Import" adds a Cardano-only account from a separate phrase, encrypted
  under the wallet passphrase; that phrase is NOT covered by the moth recovery
  phrase, which the import screen says before asking for it. Accounts imported from a raw hex seed have no
  Cardano address at all — BIP-39's phrase-to-seed step is one-way, and CIP-1852
  starts from the entropy — and every surface says so by name rather than failing
  at derivation.

  The Cardano network is derived from the Midnight network — mainnet/Mainnet,
  preprod/Preprod, preview/Preview — and cannot be chosen separately. devnet,
  qanet and undeployed have no counterpart and refuse rather than falling back to
  a testnet. Letting the two be picked independently had exactly one outcome in
  practice: cNIGHT registered on Cardano Preview against a Midnight preprod
  wallet, valid on Cardano, invisible to Midnight, and silent for the twelve
  hours you spend waiting for DUST that cannot arrive.

  cNIGHT amounts are STARs, six decimal places, as NIGHT is on Midnight. Cardano
  carries no protocol-level decimals and the asset publishes no registry entry,
  so nothing on chain states the scale and a block explorer shows the raw
  integer. Both the display and the send inputs now apply it: `--cnight 10` used
  to move ten STARs — a hundred-thousandth of what was asked for — and succeed.

  Reads and submission go through Blockfrost, which needs a project id — one per
  network, since a project id is issued for a single network and answers 403 on
  the others. Every
  surface can set one: `moth config set blockfrost-project-id`, the TUI's Network
  screen under Cardano, the extension's Cardano settings, or
  `MOTH_BLOCKFROST_PROJECT_ID`. The CLI, TUI and daemon share one store, so
  setting it once covers all three; the extension keeps its own. Without a project
  id, address derivation still works and everything else refuses with that reason.

  The ID is masked wherever it is shown back — `config get`, `config set` output,
  and the TUI's input field — because it is a credential and those all end up in
  terminal scrollback or CI logs.

  Sending ADA and cNIGHT, on every surface: `moth cardano send`, `moth daemon
  cardano send`, the TUI's `s` flow and a Send screen in the extension. The
  destination is checked against the session's own network id before anything is
  built — a well-formed mainnet address entered on a testnet is the mistake that
  actually loses funds, and the builder would otherwise accept it. Sending cNIGHT
  from a registered account warns first, because the cNIGHT that leaves stops
  generating DUST and the rest is rotated.

  Cardano account management reached the CLI and TUI too: `moth cardano account
  list|add|import|use|remove`, a `--account` flag on every `moth cardano` command,
  and an accounts view on the TUI's Cardano screen with a two-step masked import.

  DUST on the Cardano side is finality-bound: Midnight will not act on a
  registration until Cardano finalises it, about 12 hours (k=2160 blocks at ~20s).
  Native NIGHT registration takes minutes, so the two flows feel very different
  and the wallet used to claim the fast one for both. The Cardano screen now
  counts down from the registration transaction's own block time — read from the
  chain, so it survives a reinstall and is right for a registration made from the
  dApp or the CLI — and says what the wait is for.

  Registering also offers your Midnight accounts as DUST receivers instead of only
  taking 66 hex characters by hand. The DUST address is read out of each account,
  so locked accounts are offered too — the account holding the cNIGHT is usually
  not the one being paid.

  The extension can show its DUST address again: Receive gained a DUST tab and the
  DUST screen shows the address with a copy button. Neither had it, while the TUI
  showed it on the keys screen all along. It is not a "receive" address — nothing
  can send you DUST — but it is what you hand to another wallet or a Cardano
  registration to point generation at yourself.

  Also fixes `moth dust status`, which passed the wallet's Midnight address to an
  indexer query keyed by Cardano *reward* address and so reported "not registered"
  for every wallet, registered or not.

  moth registers against the `cnight_generates_dust` deployment the Midnight
  bridge actually reads: script hash 7e69087d…, the contract the node repo ships
  as `mapping_validator.plutus`. It previously used the compilation in the dApp's
  `contracts-new-aiken/plutus.json` (5027bb76…), which is newer, compiles
  cleanly, and is not deployed. Registrations against it confirmed on Cardano and
  generated nothing — the bridge has never acknowledged one, and there is no
  error anywhere to read. 51 registrations live at the deployed address; moth's
  three transactions are the only ones that have ever touched the other.

  `scripts/sync-cnight-blueprint.mjs` now pins that hash and refuses to emit
  bytes that do not match it, reads either a `.plutus` envelope or an Aiken
  blueprint, and takes `--verify-on-chain` to confirm the derived address holds
  real registrations. The hash is pinned in the tests too, as a literal. The
  check that was there before compared the compiled bytes to a hash generated
  from the same file: self-consistent by construction, and green throughout.

  The registration datum records the 33 bytes `DustAddress.serialize()` returns —
  a 0x73 type tag then the payload — matching every live registration and the
  deployed validator's own `length_of_bytearray(dust_address) <= 33`. The other
  plausible receiver, the 32-byte shielded coin public key, encodes just as
  cleanly and is a different key: Cardano accepts it and the bridge matches
  nothing.

  Registrations written against the coin public key still exist on chain, so the
  datum is read back with a range rather than a fixed length. Pinning the reader
  would not reject such a registration, it would hide it: the datum stops
  decoding, the wallet reports "not registered", and registering again mints a
  second auth NFT onto a stake key that already has one, which the validator
  rejects. A registration that cannot generate DUST is labelled as such in all
  four surfaces, with `update` offered to repoint it.

  The extension also reported a wallet's own registration as belonging to someone
  else. It compared the datum against the session's shielded coin public key,
  which the datum has not held since the receiver became a DUST address — same
  length, different key, so the comparison failed silently rather than loudly.
  It now resolves the wallet's own DUST address through the same path the
  registration writes it. The CLI, TUI and daemon derived this through
  `dustAddressBytes` and were unaffected.

  Changing the DUST address no longer adds a zero withdrawal. The validator
  authorises a key-based stake credential by signature; the withdrawal route is
  for script credentials, and its redeemer is an output reference rather than the
  unit value, so including one aborted the transaction.

  The extension's Cardano provider now implements CIP-30 in full: `getExtensions`,
  `getUtxos(amount, paginate)` with amount filtering, `getCollateral({ amount })`
  reading `cbor<Coin>`, pagination on `getUsedAddresses`, and `enable(extensions)`.
  Errors reach dApps in the shapes the spec fixes — numeric `APIError` codes,
  `PaginateError { maxSize }`, and the per-method decline codes — where previously
  every CIP-30 failure arrived as `[object Object]` with its detail dropped.
- 773443b: The daemon's `submitTransaction` answers `PROTOCOL_VERSION_MISMATCH` instead of `INVALID_PARAMS`
  when the hex is a transaction built for the other side of the ledger fork, or when the wallets
  cross the fork before it is submitted. Hex that no ledger reads still gets `INVALID_PARAMS`.
  `RpcErrorCode` gains the new member, and the CLI renders it as `INVALID_INPUT` with a "Protocol
  version mismatch" prefix.
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

### Patch Changes

- 5aff21e: `MOTH_HOME` now applies to everything moth writes to disk.

  It moved the keystore and the daemon socket but not the sync cache, daemon API
  keys, the daemon audit log, contract private state (`level-db`), the CLI's
  `timings.json` or the TUI's `moth.log`, which each built `~/.moth` themselves. A process that sets `MOTH_HOME` to isolate itself
  was still sharing those with every other instance on the account, and deleting
  a wallet looked for its socket under the wrong root.

  **If you already set `MOTH_HOME`:** those now resolve under it. Existing API
  keys, audit log, sync cache, contract private state, timings and TUI log stay in
  `~/.moth` and are not migrated. Move them across, or reissue API keys, after upgrading.
  Without `MOTH_HOME` nothing changes.
- Updated dependencies [8fcbeaa]
- Updated dependencies [e38ea20]
- Updated dependencies [db695ea]
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
- Updated dependencies [13dabe8]
- Updated dependencies [fd3366a]
- Updated dependencies [fa2a009]
- Updated dependencies [ab76749]
  - @shieldedtech/moth-wallet@0.15.0
  - @shieldedtech/moth-tui@0.15.0

## 0.14.1

### Patch Changes

- Updated dependencies [0f0afa3]
  - @shieldedtech/moth-wallet@0.14.1
  - @shieldedtech/moth-tui@0.14.1

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
  - @shieldedtech/moth-tui@0.14.0

## 0.13.0

### Minor Changes

- b49c96d: Give the CLI and TUI the pre-seed, timings and DUST-registration behaviour the
  extension already had.

  **Birthdays.** `chainTip` moves from the extension's background handlers into
  core, and `wallet generate` on both surfaces records the chain tip as the new
  wallet's birthday. Without one the `reference.height <= birthday` guard can never
  pass, so no CLI or TUI wallet could ever be pre-seeded — the difference between
  29.3s and 78.6 min on preprod. Imports still get none, deliberately: a restored
  wallet may hold funds at any height, and seeding it past its own history would
  lose them silently.

  **`moth preseed status|refresh|build`.** Thin wrappers over core functions
  that already existed but had no caller outside the extension. `refresh` is the
  one worth having — 9.1s to catch a reference up, against 53.6 min to rebuild it
  from genesis, which is what someone does by hand when the command is missing.
  `build` says how long it will take before starting, because an unattended command
  that appears to hang for an hour is indistinguishable from a broken one.

  **Phase timings on disk.** `createFileTimingStore` backs the existing
  storage-agnostic recorder with `~/.moth/timings.json` — the path
  `docs/BENCHMARKING.md` already documented and nothing wrote. `moth diagnostics
  timings` shows the timeline as deltas, and recording stays off until switched on.
  A headless sync is where this matters most: it is the surface with no other
  signal about where the time went.

  **DUST registration in the TUI.** `DustRegistrationNotYetError` is now caught
  distinctly, so a wallet whose NIGHT is too new to cover the registration fee is
  told "not yet" instead of shown the raw SDK error as a failure. The panel and the
  CLI already did this; the TUI was the surface still reporting it as a defect.
- 426b757: Detect and steer users away from the devnet dust-ledger wedge (docs/bugs-found #15-style defect).

  Some devnets (midnight-node 2.0.0-rc.4 / midnight-ledger 9.1.0.0-rc.3) can
  enter a state where a DUST registration leaves the node's dust ledger unable
  to reconcile with any wallet's, permanently — every subsequent dust spend,
  from every wallet, fails with the same `InvalidDustSpendProof` /
  `Custom error: 170` signature that a normal transient race also produces.
  Only a chain reset clears it; retrying does not. This is not a Moth defect —
  see `docs/upstream-issues/dust-ledger-wedge-invalid-dust-spend-proof.md` for
  the evidence and the draft issue against `midnightntwrk/midnight-node` /
  `midnight-ledger` — but Moth users hit it on shared and local devnets, so
  Moth now detects and steers around it rather than retrying forever.

  **Detection** (`@shieldedtech/moth-wallet`, `sync/dust-ledger-health.ts`): a
  run of consecutive, independently built submissions rejected with the same
  ambiguous signature — with the chain confirmed still producing new blocks
  meanwhile — is
  surfaced as `DustLedgerWedgedError` instead of a generic failure. Wired into
  every fee-paying submission path: the extension's offscreen host, `moth
  transfer` / `moth dust register`, and the daemon's `transferTokens` /
  `dustRegister` / `dustDeregister` RPCs (used by both the headless CLI daemon
  and the TUI).

  **Registration UX** (`@shieldedtech/moth-extension`): the "Register for
  DUST" flow now warns before registering a NIGHT coin that has sat
  unregistered for more than a minute — the only pattern with zero known
  failures across four documented occurrences is registering within seconds of
  funding — and a wallet that has never registered is nudged to do so as soon
  as new NIGHT is observed, rather than waiting for the user to find the Dust
  screen on their own.

  **Repro harness**: `packages/cli/tests/integration/daemon/dust-wedge-repro.test.ts`
  isolates the fund-to-register delay as the one variable prior occurrences
  didn't control for, holding UTXO size fixed at the size every known success
  used (10,000,000 NIGHT).

  No change to transaction construction, signing, or proving — every
  registration involved in the underlying defect was accepted by the ledger,
  so this only classifies what a rejection means after the fact.
- b49c96d: Move a pre-seed reference between machines: `moth preseed export` / `import`.

  Building a reference IS the chain walk — tens of minutes, once per network per
  machine. That cost is identical for everyone, because a reference holds public
  chain state and nothing else, so it is work that should be done once and shared
  rather than repeated by every developer who clones the repo. ADR 0005 called for
  these two actions; the rest of the command shipped without them.

  The on-disk shape is the one `scripts/export-preseed.mjs` already writes and CI
  already publishes: gzipped state per sub-wallet plus a manifest. One format, so a
  reference exported here can be dropped into the extension package, and one
  downloaded from a release can be imported here.

  `export` never writes the reference wallet's mnemonic. That is the only secret in
  the arrangement — the state blobs are public chain data, but the mnemonic
  controls the wallet they were built from, and a published reference is meant to
  be safe to hand to strangers. The command says so in its own output.

  `import` refuses rather than guesses. A bundle for another network would seed
  wallets from a chain they have never been on, and the mismatch is silent
  afterwards. A bundle older than what is already present is a downgrade that costs
  catch-up time on every wallet created from then on; `--force` allows it, for
  replacing a corrupt newer reference with a known-good older one.

  Every part is decompressed before any part is written. Unpacking as it went left
  the store holding new shielded and unshielded state beside an old dust state when
  a later part turned out to be corrupt — a mixture that never existed on chain,
  with a height key that still looked consistent. The height is written last, since
  it is what marks a reference usable.

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
- Updated dependencies [43eb678]
- Updated dependencies [ea1793d]
- Updated dependencies [316ca82]
- Updated dependencies [89f34aa]
- Updated dependencies [04f1aa4]
  - @shieldedtech/moth-wallet@0.13.0
  - @shieldedtech/moth-tui@0.13.0

## 0.12.1

### Patch Changes

- Updated dependencies [bd8d41f]
  - @shieldedtech/moth-tui@0.12.1
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
  - @shieldedtech/moth-tui@0.12.0

## 0.2.0

### Minor Changes

- 36cb067: Add selectable proof-server and local WASM proving across the core wallet, CLI,
  terminal dashboard, browser extension, and dApp connector API.
- fc93b31: Add the opt-in daemon for sharing one live wallet between a long-running host
  (the TUI dashboard or `moth daemon serve`) and CLI clients over an authenticated
  Unix-socket or TCP RPC. The daemon owns the sync engine and spending keys;
  clients route the build/balance/prove/sign/submit pipeline through it, so keys
  never leave the host process. Adds the `moth daemon serve|transfer|call|deploy|
submit-tx|dust register|dust deregister|key gen|key list|key revoke|maintenance`
  subcommands, API-key authentication with read/write scopes, an append-only audit
  log, and an L3 confirmation queue (interactive modal, or headless auto-approve
  gated behind an explicit flag + env var).

### Patch Changes

- b157dd2: Add the browser extension wallet and dApp connector workflow.

  The wallet core now supports browser-safe persisted sync state, activity history,
  message signing, staged transfer construction and submission, fee estimation,
  and DUST and intent operations. Add the WXT side-panel extension and Connector
  Lab mock dApp, expose the new APIs through the browser adapter, and keep the CLI
  and TUI integrations compatible with asynchronous sync cache handling and the
  Ink runtime.

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

- Updated dependencies [fc93b31]
- Updated dependencies [fc93b31]
- Updated dependencies [12881a3]
- Updated dependencies [b157dd2]
- Updated dependencies [c7d1ef7]
- Updated dependencies [36cb067]
- Updated dependencies [003720d]
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
- Updated dependencies [e431662]
- Updated dependencies [717639a]
- Updated dependencies [e8b98da]
  - @shieldedtech/moth-wallet@0.2.0
  - @shieldedtech/moth-tui@0.2.0
