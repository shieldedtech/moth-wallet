# @shieldedtech/moth-cli

## 0.12.0

### Minor Changes

- ea15676: Rename the project from Dusk to Moth.

  Deliberately a minor bump rather than a major one. A major signals a breaking
  change to existing consumers, and there are none: nothing was ever published to
  npm under either name, so `@shieldedtech/moth-*` is not a rename of a published
  package but the first version of a new one. Changesets promotes a major on a 0.x
  package straight to 1.0.0, and 1.0.0 would claim a stability this wallet does
  not have — the README calls it experimental and unsupported, and the default
  network is preprod precisely because it is unaudited.

  Dusk Network is an established layer-1 blockchain whose pitch — privacy-
  preserving, zero-knowledge smart contracts — is the same sentence you would use
  for Midnight. It ships its own wallet, and its token ticker is DUSK. So "Dusk
  Wallet" did not merely resemble their brand; by ordinary naming convention it
  read as _their_ wallet. The sharpest edge was that this wallet displays a
  **DUST** balance: one letter from their ticker, in a balance list, in an
  application called Dusk.

  Done before publication deliberately. Nothing is on npm, there is no Chrome Web
  Store listing and no release tag, so the identifiers that would otherwise have
  been permanent are still free to change — above all `WALLET_RDNS`, which dApps
  match on to discover the wallet, and which could not be changed after third
  parties integrated without breaking every one of them.

  Packages are now `@shieldedtech/moth-*`, the CLI binary is `moth`, environment
  variables are `MOTH_*`, and the connector identifies as `io.shielded.moth`.
  Command names are untouched: none of them contained the old name, and the `dust`
  topic is the DUST token, which is Midnight's vocabulary rather than ours.

  **The state directory moved from `~/.dusk` to `~/.moth` with no migration
  shim.** Anyone with existing CLI or TUI wallets must move it by hand:

  ```
  mv ~/.dusk ~/.moth
  ```

  A fallback that read the old path would have to stay forever to be worth having,
  and a project with no published release has no installed base to protect.

  The bundled demo token contract is renamed too, `dusk-ft` to `moth-ft`, and
  recompiled — prover keys, verifier keys and zkir regenerated from source. Its
  domain separator changes with it, from `pad(32, "dusk:ft:")` to
  `pad(32, "moth:ft:")`. That is a cryptographic constant, not a label: it colours
  every token the contract mints, so the old brand would otherwise have been
  visible on-chain in the token type forever. Tokens minted under the old
  separator are a different token type and are not reachable from the new build,
  which is acceptable only because this is a demo contract that has never run
  anywhere but a test network. The execution harness asserts the separator, so the
  two cannot drift apart.

  `CHANGELOG.md` keeps the old name throughout: it says what the packages were
  called when those entries were written, because that is what a changelog is for.

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
