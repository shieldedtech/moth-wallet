# @shieldedtech/moth-tui

## 0.13.0

### Patch Changes

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
- eb4d56a: **The extension can restore an account from a raw hex seed.** Previously it
  accepted a 24-word phrase and nothing else, which made accounts created from a
  seed permanently unreachable there.

  That was not a policy — a wallet created from a hex seed **has no mnemonic and
  can never be given one**, because BIP-39's phrase-to-seed step is a one-way KDF.
  There was nothing to type into the word grid. Meanwhile the TUI
  (`tui/src/app.tsx`) and the CLI (`moth wallet import --seed-hex`) both had the
  path, and the extension's own session model is seed-based end to end: it derives
  `seedHex` at unlock and carries it through every operation. A mnemonic was only
  ever a transport format for the seed, and the extension accepted just that one
  format at the door.

  The plumbing was the only thing missing. `wallets` in the browser facade *is* a
  `WalletManager`, so `importFromSeed` was already callable from the offscreen
  document; `unlock` already handled a `seed:` keystore. `ImportWalletRequest` is
  now a union — exactly one of `mnemonic` / `seed`, enforced by the type rather
  than a runtime check — threaded through the background/offscreen RPC, and the
  offscreen host routes to whichever core call fits. The two stay separate calls,
  not one with a branch: `import` runs the BIP-39 checksum, `importFromSeed`
  shape-checks the hex.

  The restore screen now offers both artifacts as tabs on one page. No
  "which do you have?" step first: anyone restoring already knows which they hold,
  so that step would cost a click and gather nothing.

  **New in core: `wallet/hex-seed.ts`, and `importFromSeed` now validates.** It had
  no validation whatsoever — a malformed seed reached the SDK and surfaced as a
  bare `Invalid seed`, and a merely wrong-*length* seed was accepted outright,
  silently producing a different wallet. `checkHexSeed` returns a machine-readable
  problem so each surface can word it itself (the extension localises it; the CLI
  and TUI use `describeHexSeedProblem`). The TUI and CLI inherit the fix.

  **The validation is shaped around the fact that a hex seed has no checksum.**
  Measured against the wallet SDK, `HDWallet.fromSeed` accepts any 16–64 byte
  seed and refuses 15 or 65 — and every accepted length derives a *different*
  wallet. So:

  - change one character and there is **no error**, just a different, valid, empty
    wallet;
  - truncate a paste and the same is true;
  - whereas one wrong word in a phrase fails `validateMnemonic`.

  The bounds therefore match what the SDK actually accepts rather than a rule of
  our own, with a test that fails if an SDK bump moves them. Lengths other than 32
  or 64 bytes — the two sizes real tooling emits — are **warned about, not
  refused**: a truncated paste looks exactly like a seed genuinely created at that
  length, and refusing would lock such a wallet out. And the field is deliberately
  **not** a password input: reading the seed back against a backup is the only
  check available, so masking it would remove the sole defence.

  Note those two sizes are not interchangeable. A 32-byte seed is what the Midnight
  node toolkit and `moth wallet import --seed-hex` deal in; the 64-byte one is the
  BIP-39 seed a phrase expands to, and what `exportSeedHex` returns for a
  phrase-backed wallet. Truncating the latter to the former gives a different
  wallet.

  Restored accounts keep `createdHere: false` and no birthday, so they scan from
  genesis — they may hold funds at any height, and seeding one past its own history
  would hide them (ADR 0003, rule 4).

  **The TUI's hex import was that validation.** `SeedEntryScreen` matched
  `/^[0-9a-fA-F]{64}$/` and did it *before* `importFromSeed`, so core's new check
  never ran and the screen refused every length the SDK accepts bar one — including
  the 128-character seed this release teaches the extension to reveal. Round-trip
  a phrase-backed account (extension → Accounts → Reveal → Hex seed) into the
  TUI's hex import and it answered "Invalid hex seed. Must be exactly 64 hex
  characters", while the CLI took the same string. The check now lives in
  `tui/src/screens/onboarding/seed-input.ts` and delegates to `checkHexSeed`, so
  the TUI inherits the bounds and the unusual-length warning instead of
  re-deciding them; a test sweeps 16..64 bytes so the screen cannot silently drift
  tighter than core again.

  Also corrected: three places documented a BIP-39 seed as 64 hex characters. It is
  128 — 64 hex characters is a 32-byte seed, a different artifact that derives a
  different wallet. `core/src/sync/operations.ts` and two spots in
  `docs/spec/wallet-service/05-key-management.md`. That claim is precisely what
  would lead someone to write `length === 64` validation and reject the seeds this
  app exports (#99).

  Closes #98.
- 43eb678: Bound the Wallet State view's coin lists to what the terminal can show.

  Observed on mainnet, where a shielded wallet holds far more coins than a test
  wallet does. The itemised list ran past its own section and painted over the ones
  beneath it, so the Unshielded and Dust sections printed lines like

  ```
  ▸ Unshielded Wallet
      Ba29ed4a053c1ec576e7f7684832c062bebc5cf67c0a4a9242f4defebd4b112b94  522  (1 coin)
  ```

  — that section's `Balance` label with a token row on top of it.

  The cause is not formatting. Ink renders a frame in full and has no viewport, so a
  frame taller than the terminal corrupts its redraw and lines overwrite one
  another. `components/Select.tsx` already documents exactly this ("makes Ink
  collapse the two lines onto one") and windows its list against `stdout.rows` to
  avoid it; `StateView` had no equivalent and emitted a row per token plus a row per
  coin, unbounded. `Label` pads with `padEnd` and never truncates, which is what
  identifies the 2-character `Ba` as terminal overwrite rather than a truncation
  bug — and why truncating the label would have fixed nothing.

  Each block is now bounded as a whole, with the remainder reported:

  ```
      Balance
        29ed4a05…4b112b94  522  (1 coin)
        … and 4,312 more
  ```

  Bounded as a whole because volume arrives from either direction — a wallet with
  many tokens, or a token with many coins — and capping only the inner coin list
  leaves the outer one unbounded. The rows are flattened into one list and one
  budget covers them, so neither shape can overflow. The three sections split the
  terminal's spare height; the `… and N more` line is counted against the budget it
  belongs to.

  Long token ids are now middle-elided to fit the terminal width. That is not only
  cosmetic: at 80 columns a full 64-character id wrapped the header onto a second
  line, which cost two rows where the budget assumed one.

  `Dust` had the same unbounded shape and is fixed the same way, costing a
  deregistered coin as two rows since it renders its `dtime` on a second line.

  The row arithmetic lives in `utils/` as `flattenBalanceRows`, `windowRows`,
  `truncateMiddle` and `balanceBudget`, unit-tested without rendering Ink.
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

- bd8d41f: Fix the published TUI package to use a semver dependency range for `moth-wallet` so npm consumers can install it outside the Yarn workspace.
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
