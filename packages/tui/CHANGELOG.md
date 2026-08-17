# @shieldedtech/moth-tui

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

- 003720d: Clear balances on wallet/network switch in the terminal dashboard.

  `useBalance` reset with `{...prev}`, so switching or importing a wallet briefly
  showed the previous wallet's balances, coins, and sync progress under the new
  wallet's name until the new sync emitted. It now resets to the empty state on a
  switch. There is no steady-state flicker, since the sync effect only re-runs
  when the wallet keys, network, or wallet name change.

- b7e2f00: add local network support
- e431662: Count booked unshielded inputs in the TUI's Wallet State balances.

  The core folds booked (pending) unshielded inputs into the balance it reports,
  but the state view summed only the available coin list, so the TUI and the
  extension showed different NIGHT totals for the same wallet — observed on
  preprod as 5,423.9987 against 8,423.998700, a gap of exactly the three booked
  coins. A token whose coins were all booked had no row at all and read as not
  held, while the extension still listed it.

  The fungible balance block now groups over both populations and marks booked
  coins `[in flight]` beside the existing `[Registered for Dust]` flag, so the
  booked portion is visible rather than hidden behind an opaque "Pending N coins"
  count. The grouping moved to `utils/balance.ts` as `groupCoinsForDisplay`, where
  the arithmetic is unit-tested without rendering Ink. Shielded is unchanged: its
  pending also holds incoming coins, which would over-count receipts.

- 717639a: Show DUST in DUST, not in NIGHT units, in the TUI balance table.

  `useBalance` formatted the DUST balance with `formatNight`, which divides by
  10^6 (STARS per NIGHT). DUST is denominated in SPECKS, 10^15 per DUST, so every
  figure the balance table has ever shown was too large by a factor of a billion —
  and plausibly so, which is why it survived. Now uses `formatDustBalance`, which
  core has exported all along.

  Reported as #78, with the arithmetic worked through against `formatNight`'s
  source. The same substitution was fixed separately in core's sync log line; this
  is the other call site, and the one a user actually reads.

- e8b98da: Restore the TUI build after `SyncProgress` gained a required `slowest` field.

  `overallSyncProgress` now reports which sub-wallet the percentage came from, so
  the sync line can say "syncing 27% (dust)" instead of leaving a reader to guess
  why it disagrees with a gauge showing shielded and unshielded at 100%. Making
  `slowest` required was deliberate — an unlabelled percentage is the defect — but
  two TUI literals construct `SyncProgress` by hand and were not updated, so
  `packages/tui` stopped typechecking the moment that landed.

  Both are cases where nothing is behind: the fallback used before any progress has
  been reported, and a fully-synced test stub. Both take `slowest: null`.

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
