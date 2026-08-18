# @shieldedtech/moth-wallet

## 0.12.1

## 0.12.0

### Minor Changes

- ea15676: Coordinate the first public package release under the Moth package names.

  This is a minor bump because no package has previously been published under the
  new names. The release remains experimental and unsupported, so it stays below
  1.0.0. Package names, CLI identifiers, environment variables, connector identity,
  and local state paths are aligned before publication; no compatibility shim is
  required for an unpublished package.

### Patch Changes

- be98f55: Measure test coverage in CI, and share the core test fixtures.

  Adds a second job to `.github/workflows/ci.yml` that runs `yarn test:coverage`
  and archives `lcov.info`. The measurement step is advisory: V8 instrumentation
  slows the scrypt-backed keystore and seed-export suites enough to trip vitest's
  internal worker RPC timeout, so the run exits non-zero even though every test
  passes and the report is written. `continue-on-error` is scoped to that step
  rather than the job, so a run that produces no report at all still fails on the
  upload. The strict gate stays the `test` job. Baseline at the time of writing:
  62.54% lines, 83.76% branch over 686 tests, with entrypoints and screens excluded
  as shells the E2E tier covers.

  The three `exportSeedHex` tests no longer carry a per-test 15s timeout. A
  literal there overrides the project config — which already raises the timeout
  precisely because these derive keys at the v2 scrypt parameters — and made them
  the only thing failing a `--coverage` run.

  Shared test fixtures now live in `packages/core/tests/helpers/`. Every core test
  that needs an in-memory `StorageAdapter` or the reference mnemonic takes it from
  there — four hand-rolled `MemoryStorage` classes and four copies of the mnemonic
  are gone, so a change to `StorageAdapter` now breaks compilation at every call
  site, and no test can drift from the seed the address-parity fixtures pin. The
  keystore suite shares one encrypted keystore across its shape and tamper
  assertions while keeping an independent full-strength round trip, cutting its
  scrypt derivations from thirteen to nine.

  The extension's network picker test now asserts that every network in
  `SUPPORTED_NETWORKS` is both named and described in the rendered markup, with
  developer mode on so the gated mainnet is covered too. The radio count derives
  from the state's `available` list rather than any literal, so gating a second
  network cannot fail a correct picker; a hardcoded count disagreed with the
  picker for twelve days after `local` was added without label entries.
  `NETWORK_LABELS` and `NETWORK_DESCRIPTIONS` are exported for that assertion.

  Root vitest config: `projects` is now globbed rather than listed, so a new
  package cannot be gated by CI while staying invisible to the coverage number,
  and `coverage.exclude` extends vitest's defaults rather than replacing them.

  Removes the root `lint` script and turbo's `lint` task. No package defined a
  `lint` script, so `turbo run lint` linted nothing and reported success, which
  read as a passing gate — worse than having none. `CONTRIBUTING.md` no longer
  claims a linter config lives in the repo.

  The root `vitest` range now matches `@vitest/coverage-v8`, which declares an
  exact peer on the vitest it ships with, so the two cannot drift onto an
  unsupported pairing.

## 0.2.0

### Minor Changes

- b157dd2: Add the browser extension wallet and dApp connector workflow.

  The wallet core now supports browser-safe persisted sync state, activity history,
  message signing, staged transfer construction and submission, fee estimation,
  and DUST and intent operations. Add the WXT side-panel extension and Connector
  Lab mock dApp, expose the new APIs through the browser adapter, and keep the CLI
  and TUI integrations compatible with asynchronous sync cache handling and the
  Ink runtime.

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
- fc93b31: Adopt a single derive-and-drop key model. `deriveWalletKeys(seedHex)` produces a
  typed `WalletKeys` bundle once at unlock and the raw BIP-39 seed is dropped;
  `UnlockedWallet` no longer exposes it. Every Midnight write path accepts
  `WalletKeys` directly (`sendTokensWithKeys`, `designateForDustWithKeys`,
  `dedesignateFromDustWithKeys`, and the contract call/deploy/maintenance paths),
  with the seed-based functions kept as thin wrappers so both API shapes remain
  available. `WalletManager.exportSeedHex` is the one deliberate exception, for a
  key-holder that must re-supply a serializable secret across a process/document
  boundary (the extension's offscreen document, where WASM keys can't cross the
  message channel). See docs/spec/wallet-service/05-key-management.md (D-KM-3).
- fc93b31: Report the NIGHT actually registered for DUST generation.

  `DustGeneration` gains `registeredNight` — the sum of the NIGHT UTXOs flagged
  as registered. Registration binds the NIGHT key, but each UTXO generates via
  its own on-chain record, so three amounts can differ: the balance, the
  registered NIGHT, and the NIGHT generating right now (`designated`). The
  extension's DUST screen now attributes "Total possible" to the generating
  amount instead of the whole balance, quantifies NIGHT that is registered but
  not yet generating, and offers registration whenever unregistered NIGHT
  exists (previously the CTA vanished after the first registration).

  `DustGeneration` also gains `newestRegisteredAt`, and `clearDustSyncCache`
  evicts only the dust sub-wallet's cached state. Together they power the
  extension's automatic dust-view repair: when registered NIGHT older than the
  grace period still has no generation records, the sync host rebuilds just the
  dust view (transaction-free, cooldown-guarded) instead of requiring a manual
  deregister + full resync.

  `designateForDust` now rejects an invalid DUST receiver instead of silently
  falling back to the wallet's own address, `dedesignateFromDust` is exported
  through the browser adapter, and the extension's DUST screen gains a "Stop
  generating" flow plus a receiver-address field on registration (prefilled with
  the wallet's own DUST address; any valid DUST address is accepted).

- 1c597ff: Add an optional auth header for the node, for endpoints that rate-limit.

  preprod's node answers 403 to unauthenticated callers and accepts requests
  carrying an operator-issued bypass header. Settings → Network gains two fields
  under the endpoint URLs: a header name (pre-filled with
  `x-shielded-ratelimit-bypass`, editable so a different operator or a renamed
  header needs no code change) and a masked value.

  **This needs `declarativeNetRequestWithHostAccess`, and that is not incidental.**
  A browser cannot set headers on a WebSocket handshake — `new WebSocket(url,
protocols)` takes no header argument — and the node connection is a WebSocket, so
  no JavaScript reaches it. declarativeNetRequest's `modifyHeaders` action does,
  because it rewrites the request before it leaves the browser and its resource
  types include `websocket`. The `WithHostAccess` variant reuses the
  `https://*.midnight.network/*` host permission already declared rather than
  widening access; it grants header rewriting on those hosts and nothing else.

  Scoped to the node host only. The indexer is not rate-limited today, and a
  credential should reach as few destinations as possible. The rule is dynamic
  rather than a static ruleset — a static one would ship in the package — and is
  removed when the header is cleared or the node URL changes, so a credential is
  never left pointing at a host the wallet no longer uses.

  The value is a secret and is treated as one: masked in the UI, never logged,
  excluded from developer mode (which shows endpoint, HTTP status and attempt
  count), and excluded from the diagnostics export, which promises "labels,
  durations and sizes only". It ships with an empty value — only the header _name_
  has a default — so no credential can enter the package.

  Worth stating plainly: it is stored in `storage.local`, **not** in the encrypted
  keystore, so unlike seeds it is not protected by the wallet passphrase and is
  readable by anything with access to the browser profile. The help text says so.

  Both the name and value are re-validated at the background boundary rather than
  trusted from the panel: names must match the RFC 7230 token characters and values
  must contain no CR or LF, so neither can smuggle a second header. Surrounding
  whitespace is trimmed, since pasting a token reliably introduces it.

  Two related fixes this exposed. `endpointOverridesFor` collapsed to `null`
  whenever the URLs matched the preset, which would have silently discarded a
  header set against default endpoints — the common case, since the endpoint
  needing the header is the preset one. And `getNetworkConfig` did not carry the
  header through, so nothing downstream could see it.

- 24cb16c: Keep each network's synced state and birthday, so switching networks stops costing a full rescan.

  Switching a wallet between networks used to be doubly expensive, and the second
  cost was the larger one.

  `setNetwork` discarded the wallet's `birthday` on every move. That is defensible
  in isolation — a height on preprod means nothing on preview — but `syncEnsure`
  passes `isNewWallet: false`, so the pre-seed block is entered only when a birthday
  exists. A switched wallet therefore had no birthday anywhere, could never satisfy
  `reference.height <= birthday`, and walked from genesis on every network it
  touched, no matter how many references were built or shipped.

  `walletSetNetwork` also cleared the sync cache for BOTH sides of the move, on the
  grounds that "switching back must also perform a fresh scan rather than revive
  state the user explicitly reset" — which conflated switching networks with
  resetting sync state. Resetting is its own deliberate action on the DUST screen.
  The keys were already per-network (`sync/<networkId>/<wallet>/<part>.dat`), so
  the wipe was a choice, not a constraint, and it grew expensive as dust came to
  dominate: a return trip meant 78.6 min on preprod.

  Birthdays are now per network — `birthdays: Record<string, number>` — recorded on
  first arrival and never overwritten on return, because a wallet may have
  transacted on a network before leaving and a later tip would skip that history.
  The legacy single value is folded into the map under the network it belonged to
  rather than dropped.

  Recording is gated on a new explicit `createdHere` flag. An imported wallet may
  hold funds on any chain at any height, so it never gets a birthday and keeps
  scanning from genesis. That distinction used to be implied by `birthday` being
  present at all (generate set it, import did not); splitting birthdays per network
  dissolved that signal, so it is now stored outright. Wallets written before the
  field exists read as imported — the conservative direction, since a slow sync
  costs time whereas the opposite error hides funds.

  Sync caches are no longer cleared on a network switch. Both networks' state
  coexists and a return trip resumes from the last known good state, exactly as an
  ordinary restart does. Indexer changes still clear, since a different indexer can
  disagree about history.

  The Settings copy said "Changing the network or indexer clears local sync data";
  that is now only true of the indexer, and the switch dialog no longer warns about
  losing state it keeps.

- 1f69f66: Add `refreshEmptyRefCache` — sync an existing reference forward instead of rebuilding it.

  `ensureEmptyRefCache` short-circuits on a warm reference, so updating one appeared
  to require deleting it and walking the chain again: 53.6 min on preprod. That was
  never a limitation of the mechanism, only of the entry points.
  `buildEmptyRefCache` already resumed from whatever reference state the store held
  — it syncs under `EMPTY_REF_WALLET`, and `startWalletSync` restores that wallet's
  cache like any other. The only thing in the way was the early return.

  `refreshEmptyRefCache` bypasses it, sharing the same in-flight dedup so a refresh
  cannot start a second chain walk beside a build already running.

  Measured on preview: **9.1s to advance 25,660 blocks to zero stale**, against 96s
  to rebuild the same reference from genesis — and against 53.6 min for preprod's,
  which is the rebuild this would have avoided.

  A stale reference is safe to use; it only means more catch-up for the wallets it
  seeds, at roughly half a second per hour of age. So this is an optimisation rather
  than a repair — run it before cutting a release, or on a schedule.

  ADR 0004 was written on the premise that no refresh path existed and made building
  one the precondition for the CI and distribution work. That premise is corrected
  there, along with everything it gated.

- fc93b31: Add account display labels and local token names.

  `WalletManager.setLabel` stores a user-chosen display label in the wallet's
  metadata (surfaced on `WalletInfo`/`UnlockedWallet`); the storage name stays the
  immutable key, so keystores, sync caches and sessions survive renames. The
  extension exposes this as "Rename account" and also lets shielded token rows be
  given local display names.

- 6766583: Make the phase-timings recorder storage-agnostic, so the CLI, TUI and daemon can use it.

  The recorder was extension-only by construction: it imported `wxt/browser` and
  wrote to `storage.local`, so the three Node surfaces had no equivalent even though
  they run the same core sync engine and emit the same progress stream.

  The arithmetic and the policy are identical everywhere — delta from the previous
  entry, a bounded history, an enabled cache so the hot path does not hit storage,
  and a never-throw guarantee so an instrument can never break the path it measures.
  Only persistence differs. So persistence is now a four-method `TimingStore`
  interface and everything else lives in `diagnostics/timings.ts`, isomorphic and
  dependency-free: no node builtins, no extension APIs, no WASM. Same split as
  `storage/adapter.ts` versus `storage/fs-adapter.ts`.

  Three stores ship: `FilesystemTimingStore` (`~/.moth/timings.json`, for CLI/TUI/
  daemon), the extension's `storage.local` adapter, and an in-memory one for tests
  and short-lived processes. Because the shape is shared, a timeline captured from
  the CLI is directly comparable with one from the panel.

  Two behaviours are deliberate and pinned by tests. A store that cannot answer is
  treated as disabled rather than raising, since recording is the optional
  behaviour and the failure mode must be "no data", never "broken wallet". But
  `setEnabled` and `clear` still propagate: those are deliberate user actions with
  UI behind them, and silently doing nothing would leave a toggle lying about its
  own state. `clear()` drops entries while keeping the enabled flag, which is how
  one phase gets isolated mid-session without losing what follows.

  The extension's public API is unchanged — `record`, `getTimings`, `clearTimings`,
  `setTimingsEnabled`, `timingsEnabled`, `MAX_ENTRIES` and `TimingEntry` all keep
  their names and behaviour, so no call site moved.

  docs/BENCHMARKING.md gains a CLI/TUI/daemon section, documents
  `dust-proving-check.mjs` alongside the other two instruments, corrects the setup
  command (the repo pins yarn; corepack rejects npm), notes that a slow `submitting`
  row is usually the relay backoff rather than the wallet, and flags that
  `sync-benchmark --json`'s `percentage` field changed meaning when progress moved
  to the slowest sub-wallet.

### Patch Changes

- fc93b31: Expose the outgoing transfer count on activity entries.

  `ActivityEntry` gains `outputs` — the number of external destination outputs a
  (possibly batched) transaction carried, counted from the external unshielded
  created UTxOs the wallet can see. This lets the UI represent a multi-transfer
  send as one entry that reads "3 transfers" instead of silently showing only the
  first output. Shielded recipients are unknowable (their notes can't be
  decrypted), so a shielded-only batch reports 0 and the UI falls back to the
  count of distinct tokens moved.

- fc93b31: Count booked (pending) unshielded inputs in the reported balance.

  A send or DUST registration reserves its own NIGHT UTxOs (moved from available
  to pending) while the transaction is in flight, settling them back to the
  wallet on apply. The balance previously counted only available coins, so a
  full-balance registration flashed the displayed balance down to zero until the
  transaction applied. Unshielded pending holds only these booked inputs — never
  incoming coins — so folding them into the balance is safe and never
  over-counts receipts. Shielded is unchanged (its pending includes incoming).

- 12881a3: Make sync-benchmark actually measure the pre-seeded path.

  The script could not measure the thing it exists to measure, and said nothing
  about it. Two independent faults, either of which was sufficient:

  - The measured wallet was given a bare `InMemorySyncStateStore`, but
    `ensureEmptyRefCache` looks for the reference in whatever store the wallet was
    given. So it searched an empty store, found nothing, and measured the unseeded
    path. A run in the same process as `--warm-reference` only found the reference
    through the module-level `refCache`, never from disk.
  - The birthday was read before warming. Warming takes minutes to an hour and the
    chain moves under it, so the birthday came out older than the reference the run
    had just built, `reference.height <= birthday` failed, and the guard correctly
    refused to seed — while the run announced "reference ready … should start at
    tip".

  Both are fixed. The birthday is now read after any warm, and the measured wallet
  gets an overlay store that reads the reference keys through to disk while keeping
  every write in memory — so a run still never leaves wallet state in `~/.moth`,
  and never mutates the reference it is measuring against.

  Verified on preview: 94.5s unseeded, **2.2s** seeded, 96.0s to build the
  reference. Previously both modes reported 94.5s.

  `emptyRefHeightKey` is now exported from the core barrel; the overlay needs it to
  know which keys belong to the reference.

  This also means any previously recorded "warm reference" figure came from a run
  that measured the unseeded path, and should be re-measured rather than trusted.
  docs/BENCHMARKING.md now says so, documents the `Pre-seed complete` line to check
  for, and records the preview numbers.

- c7d1ef7: Apply the SDK console-noise filter in the browser, not just in Node.

  `SDK_NOISE` has always listed the strings the wallet SDK and @polkadot emit on
  every reconnect — `API-WS`, `disconnected from`, `Abnormal Closure`,
  `RPC-CORE`, `subscribeRuntimeVersion`. But the installer bailed out when
  `process` was undefined, so the CLI, TUI and daemon got a clean console while the
  extension — the surface most users actually see — got all of it.

  The console patch now runs everywhere. The stdout/stderr interception stays
  Node-only, since @polkadot's logger writes directly to those streams there and a
  browser worker has no equivalent; so does the `unhandledRejection` handler,
  deliberately, because a swallowed rejection in the worker would hide failures the
  extension has no other channel to report.

  The curated list is unchanged, and the rule behind it still holds: specific
  strings only, never broad patterns that could swallow a security-relevant error.

  One thing this cannot reach: `WebSocket connection to '…' failed: 403`. Chrome
  emits that from its network stack rather than from JavaScript, so no console
  patch touches it. That is the right outcome — it is not benign. It means the node
  is genuinely unreachable, and the relay banner now says so in the UI while the
  backoff keeps the repetition to roughly one line a minute instead of twenty-four.

- 6f914fc: Clear nine Dependabot advisories in transitive build dependencies.

  All ten open alerts are transitive, and every one arrives through build or dev
  tooling — `web-ext` (via WXT's Firefox support), `changesets`, `vite`,
  `node-notifier`. None is reachable from the shipped extension bundle, checked
  against `.output/chrome-mv3`. That lowers the severity in practice but does not
  make them worth leaving.

  Resolved via `resolutions`, which this repo already uses for the same purpose:

  | package         | was    | now    | severity |
  | --------------- | ------ | ------ | -------- |
  | shell-quote     | 1.7.3  | 1.10.0 | critical |
  | adm-zip         | 0.5.18 | 0.6.0  | high     |
  | brace-expansion | 5.0.7  | 5.0.9  | high     |
  | js-yaml         | 4.3.0  | 4.3.1  | high     |
  | tmp             | 0.2.5  | 0.2.7  | high     |
  | uuid            | 8.3.2  | 11.1.1 | medium   |
  | esbuild         | —      | 0.28.2 | low      |

  Pinned to the lowest patched major rather than `>=`. An open-ended range let
  yarn take js-yaml 5.2.3 and uuid 14.0.1 — several majors beyond what the
  advisories require, and a far larger change than the fix warrants.

  `elliptic` (low, via `browserify-sign`) has no patched version published and is
  left open. It is a transitive dependency of a build-time crypto shim, not of the
  wallet's own cryptography, which runs through the Midnight ledger WASM.

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

- fc93b31: Fix contract circuit calls being rejected with "expected proof-preimage-versioned".

  `callCircuit` previously used a hand-rolled proof provider that POSTed the bare
  proof-preimage, producing an unversioned `midnight:proof-preimage:` payload that
  ledger-v8's `check` rejects. Circuit calls now generate proofs through the
  selectable proof provider: for server proving it routes through the SDK's
  proving provider and the ledger's versioned `createProvingPayload`/
  `createCheckPayload` (attaching the circuit's wrapped-IR from the ZK config),
  and it also supports local WASM proving. Verified with an on-chain preprod mint.

- ba86b72: Bump ws from 8.20.1 to 8.21.0.
- fc93b31: Fix the transparent keystore KDF upgrade writing to a phantom storage key
  (`wallets/<name>` instead of `wallets/<name>.keystore`). The re-encryption to
  stronger scrypt parameters never persisted, so it re-ran on every unlock and v1
  keystores were never actually upgraded. It now writes back to the real keystore
  path and upgrades once.
- b7e2f00: add local network support
- 0f9369f: Pre-seed each sub-wallet independently, so a DUST rebuild stops walking from genesis.

  The pre-seed gate tested the SHIELDED cache alone, as a proxy for "this wallet has
  no state yet". That proxy failed exactly where it mattered most.

  `clearDustSyncCache` evicts the dust cache and nothing else, which is what the DUST
  screen's "Rebuild records" does. Shielded was therefore still present, the gate
  stayed shut, and dust walked all 1.4M events from genesis — 78.6 min on preprod —
  with a perfectly usable reference sitting in the store untouched. "Rebuild
  records" is precisely what a user reaches for when dust looks wrong, so the
  narrow, careful-looking operation was the slowest to recover, while a full
  indexer-change wipe (which clears all four parts) re-seeded and finished in
  seconds.

  The gate now opens when ANY seedable part is missing, and each part is written
  only where absent — a part that already has a cache is at least as far along as
  the reference, so seeding over it would discard progress.

  Mixed heights are coherent, and were verified rather than assumed. The
  sub-wallets carry independent cursors, so dust can restore at the reference's
  height while shielded and unshielded resume at tip, each catching up on its own
  stream. Two measurements on preview:

  - dust rewound to the reference (64,771) with shielded at tip (64,982): fully
    synced in 1.0s, balances identical.
  - a real DUST rebuild on a funded, dust-registered wallet: `Pre-seed complete —
dust at chain tip`, dust resumed at 64,771 instead of 0, synced in 1.0s, with
    NIGHT, the DUST registration and the DUST balance all preserved.

  The decision moves to `sync/preseed-parts.ts`, WASM-free so it is unit-testable
  without loading the ledger — the same split as `sync/progress.ts`. Its tests pin
  the case that was broken: shielded and unshielded cached, dust absent, must seed
  dust.

- bf49ced: Sync the pre-seed reference wallet to chain tip before serializing it.

  `buildEmptyRefCache` started the reference wallet and stopped it immediately.
  `startWalletSync` resolves on the first balance emission (or a 5s timeout), so
  `stop()` serialized a wallet that had applied nothing: every sub-wallet snapshot
  was written with `offset: 0`, which the SDK reads back as `appliedIndex: 0n` —
  its "stream from genesis" sentinel. The pre-seed then reported "shielded +
  unshielded + dust at chain tip" while seeding genesis, and had done so for as
  long as the cache had existed. Shielded and unshielded hid it because their
  genesis scan is cheap; dust made it visible as an hour of syncing.

  Measured on preprod, brand-new empty wallet, cold cache:

  - before: dust synced at 4715.8s, total 78.6 min (99.2% of it dust,
    1,382,732 events at ~293/s)
  - after: total 49.2s, of which 46.7s is one DustLocalState.deserialize

  Building the reference now costs one full chain walk (71.3 min on preprod) per
  network per machine, so it must not sit on the wallet-startup path — waiting there
  would block the user's own wallet for over an hour. `ensureEmptyRefCache` therefore
  no longer builds by default: it returns a reference already at tip, or nothing.
  Deliberate builds go through the new `warmEmptyRefCache()`, intended for a
  background task or an explicit command. A warm on-disk reference is picked up in
  0.02s, and a build that times out leaves its partial state for the next attempt to
  resume rather than handing out a useless snapshot.

  `loadUsableRefStates` gates on the serialized cursor, so a reference at offset 0
  is never again treated as warm. Also corrects the docblock claiming dust cannot be
  pre-seeded: dust ledger events are global (the indexer streams `dustLedgerEvents`
  keyed by a global id) and an empty wallet has no designations of its own, so the
  reference's generation tree and cursor do transfer — now verified end to end.

  Also adds the birthday guard that making this work turned from latent into live.
  The pre-seed condition is `(isNewWallet || birthday) && no shielded cache`, which
  admits any wallet merely missing a cache — including a funded one after a cache
  reset, a storage eviction, or a restore from mnemonic. Seeding such a wallet from
  a reference newer than its own first activity starts it past its own history and
  drops funds from view. Harmless while the reference sat at offset 0 (seeding
  genesis is always safe); a real hazard once it carries a tip cursor.

  Pre-seeding now requires `birthday !== undefined && reference.height <= birthday`.
  The height is recorded separately at build time (`emptyRefHeightKey`) because the
  snapshots' `offset` is an event index, not a block height, and the two are not
  comparable — 1,382,805 against 1,977,245 on preprod. It is read after the sync
  completes, which can only overstate it and therefore only make the check stricter,
  and a reference with no recorded height is treated as unusable rather than
  guessed at. Existing callers are unaffected: the TUI passes `isNewWallet` without
  a birthday and the CLI passes neither, so both keep the slow path.

  Nothing calls `warmEmptyRefCache()` yet, so no shipped surface changes behaviour:
  new wallets still sync from genesis until a caller warms the reference.

- 0f197e2: Preserve transaction identities in activity entries and submitted transaction records so applied transactions replace their pending rows instead of appearing as duplicates.
- fc93b31: Fix transfer submission to return `transactionHash()` instead of the facade's
  last intent identifier. Tx history, indexer status queries and explorers are all
  keyed by the transaction hash, so the old value matched nothing — leaving the
  extension's activity feed stuck on "Pending" after a transfer had applied.
- 2fde86f: Report sync progress from the slowest sub-wallet, not the shielded one.

  Progress read shielded indices only, on the stated assumption that shielded was
  the slowest sub-wallet. It is not — dust is, by two orders of magnitude: a full
  dust walk is ~1.4M events at a few hundred per second, where shielded covers the
  same range in under a minute.

  Observed on preprod: a wallet reporting "100% (0s remaining)" with dust at
  178,029/1,395,558 and roughly 69 minutes of work left. That is worse than
  reporting nothing, because it stops the user waiting.

  Progress is now the minimum across all three sub-wallets. A sub-wallet with
  nothing relevant to apply (total 0) counts as complete rather than stalled — a
  fresh wallet's unshielded progress is legitimately 0/0 and must not drag the
  minimum to zero. The figure never rounds up to 100% while the facade still says
  unsynced, since rendering a near-complete fraction as "100% (0s remaining)" is
  the specific lie this change exists to remove. The ETA follows the same fraction,
  so it reflects whichever sub-wallet is actually behind rather than one that
  finished a minute in.

  The arithmetic moved to sync/progress.ts so it can be unit-tested without loading
  WASM — the same split as types/tokens.ts and the extension's dust-heal.ts.
