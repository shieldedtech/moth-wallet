# @shieldedtech/moth-cli

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
