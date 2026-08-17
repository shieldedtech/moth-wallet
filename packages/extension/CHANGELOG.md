# @shieldedtech/moth-extension

## 0.12.1

### Patch Changes

- @shieldedtech/moth-wallet@0.12.1
- @shieldedtech/moth-browser@0.12.1

## 0.12.0

### Minor Changes

- ea15676: Coordinate the first public package release under the Moth package names.

  This is a minor bump because no package has previously been published under the
  new names. The release remains experimental and unsupported, so it stays below
  1.0.0. Package names, CLI identifiers, environment variables, connector identity,
  and local state paths are aligned before publication; no compatibility shim is
  required for an unpublished package.

- ea15676: Count requests to the node and indexer, with outcomes, on the debug page.

  Written for a specific problem: one person sees HTTP 403 from the node and
  nobody else does. 403 there means rate limiting, so the useful evidence is
  request volume — but nothing measured it, and "it feels like a lot" is not
  something you can take to whoever runs the endpoint.

  `debug.html` now shows, per host over a rolling five minutes: total requests,
  the rate now, the mean over the last minute, the **busiest single second and
  when it occurred**, and what came back.

  The peak is the number that matters most. A mean of 0.8/s reads as harmless
  while a burst of forty in one second is what actually gets refused — and by the
  time anyone opens this page the burst is over, so it has to be retained rather
  than sampled. It is measured as a sliding second, not a fixed bucket, so a burst
  that straddles a boundary is not split in half and understated. 403 is
  called out by name rather than folded into a 4xx bucket, because it is the
  answer this exists to give, and a network-level failure is counted separately
  from an HTTP error — they are different problems.

  The figures outlive both things that used to erase them. Rates are windowed
  because a rate over all time means nothing, but totals, outcomes and the peak
  are kept for as long as the browser has been open. Two separate mechanisms were
  throwing them away: the rolling window pruned a host out of existence once its
  last request aged past five minutes, and the meter itself lives in the offscreen
  document, which every lock closes — so a wallet that got two 403s and then
  auto-locked showed an empty page. Both cases hid exactly the evidence someone
  opened the page to read. The peak is now computed as each request arrives rather
  than swept from a list that pruning may since have emptied, and the background
  retains each meter's figures across the gap when a new one replaces it. Folding
  is a sum for counts and a **max** for the peak — two bursts of 30 are a peak of
  30, not 60. Each row carries how long that host has been quiet, so a retained
  403 from an hour ago cannot read as one happening now.

  The retained figures live in `storage.session`: memory-only, never written to
  disk, which matters because the captured failures carry request bodies. Nothing
  drops them implicitly — which is why **Clear** now zeroes the counters as well
  as the timings, since otherwise there would be no way to start from a known
  baseline before reproducing a problem.

  Two things worth knowing about the numbers. Requests are counted when **sent**,
  not when they resolve, because that is what a rate limiter sees; a request still
  in flight appears in the total with no outcome yet. And the meter wraps `fetch`
  and `WebSocket` in the offscreen worker, installed before the host is
  lazy-imported, so it catches the wallet SDK's own traffic — which is most of it.
  Counting only our `IndexerClient` would have measured a small fraction and
  looked reassuring.

  Always on, with no toggle. A counter you have to remember to enable is one you
  do not have when the problem happens. The cost is an array push per request
  against a network round trip, and the window is pruned on every read so a long
  session cannot grow it.

  Counts alone answer "how much", but not "is it us". A 403 could be the wallet
  sending something malformed or the endpoint refusing this caller, and telling
  those apart means sending the same request from outside the extension. So the
  last five failures are also kept verbatim — method, URL, headers, body, and
  what came back — each with a **Copy as curl** button that replays it.

  The curl emits `$MOTH_NODE_AUTH` where the node auth header belongs. That header
  is injected by `declarativeNetRequest` after JavaScript hands the request off,
  so it is genuinely not visible to the capture; a command that quietly omitted it
  would fail for a different reason than the original and send someone chasing the
  wrong thing.

  One rejection is deliberately not captured. The relay probe GETs the JSON-RPC
  endpoint once a minute in order to be refused — a healthy Midnight node answers
  405, and any HTTP answer at all proves the endpoint is alive rather than down.
  Recording that as a failure filled all five slots with the same expected 405
  within five minutes and evicted the 403s the panel exists to preserve. It is
  still counted in the table, because volume is volume; it just does not consume
  the evidence buffer. A POST that gets 405 is a genuine surprise and is still
  captured.

  Capture is deliberately conservative. A request body is only read when it is
  already a string — a stream is left alone and reported as absent, because
  consuming it would break the very request being diagnosed. The response is read
  from a clone, so the wallet still gets its own body. Header values matching
  `auth|token|cookie|secret|key|bypass` are replaced with `[redacted]`, bodies are
  truncated, and only the newest five are held.

  This splits the page in two, and the UI says so. The counts remain hosts and
  numbers only, and **Copy JSON** exports just those — still safe to paste into an
  issue unread. The failures panel carries real request contents, is marked as
  such, and is copied one at a time on purpose: nothing puts it on the clipboard
  without a deliberate click.

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

- ea15676: Say what the wallet is on the first screen: a developer wallet for Midnight.

  The welcome panel and setup tab opened with **"Money, but private."** Both halves
  of that were claims the wallet does not keep.

  There is no money. `DEFAULT_SETTINGS` puts a fresh install on preprod, and the
  comment above it says why: the wallet is unaudited and for development, so a new
  install must not land on a network carrying real value. The first screen was
  promising money immediately before a deliberate decision to keep the user away
  from any. What they actually hold is tNIGHT.

  Privacy is not unconditional. This wallet holds a shielded _and_ an unshielded
  sub-wallet, and unshielded balances and transfers are public on chain. "but
  private." made an absolute promise on the screen before the user learns there
  are two kinds of address — the intro line beneath it was already more careful
  ("with your details shielded"), but the 72px headline is what gets read.

  It now reads **"Your wallet for Midnight."**, describing the tool rather than
  making a claim on the network's behalf, with the qualification below the buttons
  where it belongs: unaudited, built for development, new wallets start on a test
  network. Under the buttons rather than in the headline, so it qualifies the
  offer instead of competing with it.

  Both screens also stop naming mainnet's assets. `nativeAssetLabelsForNetwork`
  was called with a hardcoded `'mainnet'`, so the intro said "hold NIGHT" on a
  screen whose own button creates a wallet on preprod holding tNIGHT. There is no
  selected network before a wallet exists, so the honest thing to name is the one
  the next step will use — `DEFAULT_SETTINGS.network`.

  Translations updated. The French line one is "Portefeuille" rather than "Votre
  portefeuille": the setup tab sets the first line at 72px in a 520px column, and
  eighteen characters there wrap into a third line the layout is not built for.

- ea15676: Stop reporting a DUST registration that never happened, and show why.

  A registration that registers nothing resolves normally — it returns no
  transaction hash rather than throwing. The timings log recorded "complete" for
  anything that did not throw, so a wallet which submitted nothing at all wrote
  `tx: register complete`, indistinguishable from a real registration. A log
  showing two of those, with NIGHT flat and DUST at zero for thirteen minutes,
  therefore said the opposite of what had happened.

  The label now names the outcome: `submitted`, `no-op (fee not affordable yet)`,
  or `no-op (no available unregistered NIGHT)`. The two no-ops are kept apart
  because they have different causes and different fixes — one resolves by
  waiting, the other by settling a stuck transaction — so folding them together
  would only move the ambiguity somewhere else. No transaction hash is recorded:
  the timings page promises labels and durations only, and a hash is
  chain-linkable to the wallet.

  "Your NIGHT is not available to register right now" is raised when there is no
  available _unregistered_ NIGHT while the wallet still shows a balance. Those are
  different numbers. The displayed balance folds in **booked** coins — inputs
  reserved by a transaction that has not settled — so a wallet can read 500 NIGHT
  and have nothing to register. Telling "all booked" apart from "all already
  registered" meant opening the TUI, the only surface carrying per-coin flags.

  The DUST screen now offers a per-coin breakdown: each NIGHT coin as generating,
  not registered, or booked, with the booked total named explicitly. Values only —
  no UTXO ids, addresses or nonces: enough to explain the balance, not enough to
  identify a coin on chain. Collapsed by default, since it answers a question most
  people never ask and the fetch reaches the offscreen host.

- ea15676: Stop telling people to wait for tNIGHT they already hold, and always show the
  DUST meter.

  The meter's fallback text was "Waiting for tNIGHT" whenever generation capacity
  was zero. Capacity is zero in two quite different situations: the wallet holds no
  NIGHT, and the wallet holds NIGHT that has not been registered for generation.
  Only the first is waiting for anything. The second is a wallet with capacity
  available to it and an action to take, being told to sit still.

  It now distinguishes them. No NIGHT reads "Waiting for tNIGHT"; NIGHT held but
  unregistered reads "tNIGHT not registered yet"; registered NIGHT reports its ETA
  as before. `DustView` also exposes `unregisteredNight`, so a caller can offer the
  registration action rather than re-deriving the state.

  The card is now shown whenever balances exist. It was previously hidden for a
  wallet with no NIGHT and no tokens, which made the DUST mechanism look absent
  rather than idle — and #101 had already carved out an exception for holding DUST
  without NIGHT. Two exceptions to a rule is a sign the rule was wrong: the card
  says which state it is in, so the panel does not need to decide by omission.

  This supersedes #101's "hide the meter when there is no DUST either", and that
  test is updated rather than deleted so the change of intent is visible.

- ea15676: Make the DUST components' asset labels a required prop, so mainnet cannot
  silently render tNIGHT/tDUST.

  `DustMeterCard` and `DustRingGauge` defaulted `labels` to
  `TESTNET_NATIVE_ASSET_LABELS`. Any caller that omitted the prop got testnet
  naming on every network, mainnet included, with nothing to indicate it — a
  default that is wrong on the one network where being wrong matters. Calling real
  NIGHT "tNIGHT" tells someone their funds are test funds.

  Both existing callers already pass labels, so this changes no rendering today.
  It makes the failure a compile error rather than a silent one, which is the
  point: the next caller cannot introduce it.

  Adds tests for `nativeAssetLabelsForNetwork`, including that it tolerates case
  and whitespace in the network id — it is fed from stored settings and message
  payloads, neither normalised — and that an unknown network falls back to testnet
  names. That direction is deliberate: understating real assets as test assets is
  recoverable, while labelling test assets as real could persuade someone to send
  funds they cannot get back.

- ea15676: Show the real version in Settings, instead of "Moth 1.0".

  The footer read `Moth 1.0 · Your keys never leave this device`. Two problems in
  one line.

  The version was wrong, and had been through eleven releases — the extension is
  at 0.11.0. A hardcoded version string has no mechanism to stay true, so it drifts
  from the first release onward. It now reads
  `browser.runtime.getManifest().version`, which cannot.

  The claim was dropped rather than reworded. It is broadly accurate — keys are
  derived and dropped, and the keystore never leaves the device — but an
  unqualified security assurance sits badly on a wallet that says elsewhere, at
  some length, that it is unaudited, unsupported and for development. The mainnet
  gating exists to make exactly that point. A footer quietly asserting the opposite
  undercuts it.

  Keeping a version display rather than removing the footer entirely: the
  bug-report template asks reporters for "Version / commit", and this was the only
  place in the UI showing one.

  Adds a **Copy diagnostics** button under a new Support section, producing a
  markdown block for bug reports: wallet version, browser, OS, network, whether
  endpoints are overridden and to what, prover type, auto-lock, developer mode,
  and pre-seed reference state.

  What it excludes matters more than what it includes, because a user pastes this
  into a public issue without auditing it first. No addresses, account names,
  balances or key material — the input type has no field for any of them, so a
  later edit to the renderer cannot leak one by accident. The node auth header is
  reported as set or not set, never by value; it is a shared secret. Any userinfo
  in a URL is stripped, since `https://user:pass@host` is a credential wearing a
  URL's clothes. The output says so on its last line, so a reader can trust it at
  a glance rather than reading it line by line.

  The redaction rules are a pure function with 12 tests, since that is the part
  worth getting right.

- ea15676: Show the DUST meter when a wallet holds DUST but no NIGHT or tokens.

  DUST is earned by registering NIGHT, not received, so it outlives the NIGHT that
  generated it — after spending, or while a transfer is in flight, a wallet can
  hold DUST and nothing else. The panel treated that as an unfunded wallet: it hid
  the meter and showed the "add your first NIGHT" prompt, reporting a balance of
  nothing while the total was demonstrably non-zero.

  The `fresh` flag is deliberately unchanged. It also disables Send, and with no
  NIGHT there is genuinely nothing to send — so the funding prompt stays and Send
  stays disabled. Only the meter's visibility is separated out, because that is
  what was actually wrong.

- Updated dependencies [be98f55]
- Updated dependencies [ea15676]
  - @shieldedtech/moth-wallet@0.12.0
  - @shieldedtech/moth-browser@0.12.0

## 0.11.0

### Minor Changes

- ebd0648: Ship a pre-built pre-seed reference for preprod, so a fresh install doesn't walk the chain.

  Without a reference, a new account walks the whole chain — 78.6 minutes on
  preprod, 99.2% of it dust. Building one on the device costs that same walk, so it
  cannot sit on the startup path, which left every fresh install paying full price.
  The reference is public chain state with no user-specific content (preSeedNewWallet
  swaps the new wallet's keys in and keeps only `state`, `protocolVersion` and
  `offset`), so it can simply be shipped already built.

  Measured on preprod, seeded from a reference 59,236 blocks stale: **103.1s to
  fully synced, against 78.6 minutes**. Staleness costs catch-up time, not
  correctness — the wallet syncs forward from the reference height — so a reference
  cut at release time stays useful for as long as the release does.

  Bundled rather than fetched at runtime. Inside the signed package it is exactly as
  trustworthy as the code that reads it, adds no network dependency, and leaks
  nothing; a runtime fetch would tell whoever hosts it that a given IP created a
  wallet on a given network at a given time, which is the moment least worth
  leaking in a privacy wallet.

  Costs 4.81 MB gzipped, taking the package from 17.1 MB to 21.9 MB — proportionate
  against the 13.6 MB of WASM already there.

  Safety properties, each pinned by a test:

  - The height is written LAST. `loadUsableRefStates` treats a reference with no
    recorded height as unusable, so an interrupted install leaves state that is
    ignored rather than trusted — the failure mode is a slow sync, never a wallet
    seeded from half a reference.
  - All three states or none. A reference missing its dust state is worthless, and
    writing the other two would waste quota.
  - Never overwrites an existing reference, since a locally built one is at least as
    fresh as anything shipped.
  - Never throws. A missing, corrupt or unfetchable asset falls back to the slow
    sync path rather than stopping the wallet.

  The `reference.height <= birthday` guard is unchanged and still decides who may
  use it, so an account created before the shipped reference was cut is refused
  exactly as it would be for a locally built one.

  `scripts/export-preseed.mjs` regenerates the packaged files from a locally built
  reference; re-run it before a release to cut a fresher one. Only preprod ships
  today — other networks are a no-op and sync the slow way.

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

### Patch Changes

- dd59043: Give dark mode a solid `--secondary` so the active tab pill reads.

  `--secondary` was a translucent Moonlime tint — the same family as `--accent` —
  and it carries lifted surfaces: pills, chips, the dust card, the active tab.
  Against the TabsList track, which is `--muted` (white at 8%), a translucent tint
  of the accent does not separate, so the active pill and its track read as nearly
  the same surface.

  Now solid deep green `#2e4a1e`, the light theme's `accent-foreground`. Dark leans
  green rather than remapping the light roles: Moonlime marks selection, this
  carries surfaces, and the two stop competing. Separation is by hue, with text
  colour as a second cue rather than the only one — the same reasoning as this
  theme's colourblind-safe status colours.

  `--muted` and `--secondary` are a pair and have to move together; that is now
  recorded next to them.

- fac5a30: Add an opt-in phase-timings instrument and a benchmarking guide.

  The wallet already announces every phase it moves through — core sync progress
  messages and transaction stages. Stamping those at the service-worker boundary
  turns them into a timeline with no changes to core: the gap between two labels is
  the cost of the phase between them. That technique localised the pre-seed
  reference cost to a single 46.7s DustLocalState.deserialize with every other
  startup stage at 0.0s; this makes it available in the browser.

  Recording is off by default and a no-op when off, keeps the newest 500 entries in
  storage.local, and every write is wrapped so instrumentation can never disturb the
  path it measures. It captures labels, durations and sizes only — never addresses,
  amounts, token ids or wallet names — so a timings file is safe to paste into an
  issue.

  Surfaced as a standalone `debug.html` entrypoint rather than a Settings row,
  because the panel shows the get-started screen until a wallet exists, and account
  creation and the reference build are exactly the phases worth measuring then. The
  page is reachable in any state, including with no wallet and no unlocked session.

  Also records the markers the event streams cannot infer — `unlock: start`,
  `unlock: keys ready`, `create: start`, and the first balances emission, which is
  the moment the panel can finally render and therefore the number "why is unlock
  slow" is actually about.

  docs/BENCHMARKING.md documents both instruments (this page and
  scripts/sync-benchmark.mjs), the per-phase recipes, the measured reference
  figures, and the pitfalls — including the measurement contamination that produced
  a 1052s outlier against two independent ~49s measurements.

- 7b1849c: Stop reporting a failed DUST registration as success.

  Core's `designateForDust` returns a bare `null` for two unrelated situations —
  every NIGHT UTxO is already registered, and there were no NIGHT UTxOs available
  to register — and the panel mapped `txHash === null` straight to the success
  screen "Already generating tDUST · Your tNIGHT was already registered".

  Observed on preprod while its node was refusing connections (HTTP 403): a
  registration was built and proved, submission never landed, and its NIGHT stayed
  booked. Every later attempt found nothing _available_, returned null, and was
  reported as an accomplished registration — on the same screen whose detail row
  read "Dust generation: Not registered". The displayed balance still showed 10
  tNIGHT throughout, because the unshielded balance deliberately folds in booked
  coins so a send doesn't flash it to zero mid-flight. So the wallet showed a
  balance, claimed it was registered, and said it wasn't, all at once.

  `registerOutcome` now classifies the four cases from data the panel already
  holds, with no change to core and no change to the five other callers of
  `designateForDust`:

  | txHash | registered | NIGHT balance | outcome            | screen  |
  | ------ | ---------- | ------------- | ------------------ | ------- |
  | set    | —          | —             | submitted          | success |
  | null   | true       | —             | already-registered | success |
  | null   | false      | 0             | no-night           | failure |
  | null   | false      | > 0           | unavailable        | failure |

  The last two registered nothing, so neither is shown as success. `unavailable`
  explains that an earlier transaction may still be in flight and to retry once it
  settles — which is the actionable truth when a node is unreachable.

  The classifier is a pure function in its own module so each case is pinned by a
  test, since conflating them is exactly what produced the wrong screen.

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

- c1971a2: Hide mainnet unless developer mode is on, and warn before switching to it.

  The package description has always said what this is: experimental, unaudited,
  no warranty, for development and testing. The network picker did not act like it
  — mainnet sat in the list beside the testnets, and `DEFAULT_SETTINGS.network` was
  `mainnet`, so a fresh install landed on real value without choosing to.

  `selectableNetworks(developerMode, current)` filters the picker, and the
  confirmation dialog gains a warning when the target carries real value. The
  default moves to preprod in both `DEFAULT_SETTINGS` and the setup flow's initial
  state — the two had to agree, and preprod is also the network with a bundled
  pre-seed reference, so the safe default is the fast one.

  The network a wallet is already on is always offered, whatever the setting.
  Hiding it would strand that account with no way back — the gate is there to stop
  people arriving by accident, not to trap anyone who is already there.

  Existing installs keep the network they saved; only new ones see the new default.

  The list is a constant rather than a flag on the network definition, because
  "carries real value" is a property of the deployment rather than of the wallet's
  configuration, and there is exactly one of them today.

- 4b0d09e: Stop emitting modulepreload links that Chrome discards and complains about.

  Vite emits a `<link rel="modulepreload" crossorigin>` per shared chunk per HTML
  entry. On a `chrome-extension://` URL the `crossorigin` attribute puts the
  preload in a different fetch world from the module load that follows, so Chrome
  discards it and logs "A preload for … is found, but is not used because it is a
  cross-world extension resource mismatch" — then logs a second time when the
  unused preload expires. Several lines on every page load, across the panel, the
  offscreen document, setup, approval and debug pages.

  Nothing is lost by dropping them. Preloading exists to hide network latency, and
  these resources come off local disk inside the extension package; Chrome was
  already refusing to use them, so the only thing that disappears is the warnings
  about them. Purely a tidiness change — three lines per page load, no behaviour
  attached.

- 015bbe3: Keep panel CTAs on screen when content overflows.

  `PanelScreen` used `min-h-screen`, which sets a floor with no ceiling: content
  taller than the viewport grew the container past it, pushing the bottom CTA below
  the fold, and `overflow-y-auto` never engaged because its parent had grown to fit
  rather than constraining it. On a taller window the content fitted and the button
  reappeared, which made it look like a rendering quirk rather than a layout bug.

  Reported as the Accounts screen's "+ New account" button being invisible unless
  the browser was full-screen or on a larger monitor — but it affects every screen
  built on PanelScreen (16 of them) once its content is tall enough.

  Bounds the container with `h-screen`, adds the `min-h-0` a scrolling flex child
  requires (its min-content height otherwise floors it), and `shrink-0` on the CTA
  row so it cannot be compressed instead.

- f793def: Offer the "Speed up new accounts" build only where nothing prepared ships.

  The setting predates bundling. When it was added, no reference shipped with the
  extension, so building one on the device — a chain walk, 53.6 min measured on
  preprod — was the only way to get one, and offering it on every network was
  right.

  preprod now ships a reference in the package, installed on first unlock. Offering
  the build there is offering an hour of work to arrive at what the user already
  has on disk, and the "Off" copy telling them new accounts would otherwise scan
  the whole chain is no longer true for that network.

  `preseedStatus` gains `bundled`, probed from the packaged manifest rather than a
  hardcoded network list, so the answer cannot drift from what `public/preseed/`
  actually contains. `preseedControl` turns that into the three states the row can
  be in — ready, included, or offer — and only `offer` renders the control.

  Two details worth stating because they were nearly wrong:

  The probe requires a manifest that parses with a positive height, not merely a
  fetch that succeeded. `wxt dev` answers unknown paths with the app's HTML rather
  than a 404, so a bare `response.ok` would report every network as bundled in dev
  and silently hide the toggle. `installBundledReference` shares the same parse.

  Before the status arrives the row renders nothing rather than guessing. Guessing
  "offer" flashes an hour-long build offer that the first poll retracts; guessing
  "included" claims a reference not yet confirmed.

  This does not change what warming can achieve where it is still offered. The
  `height <= birthday` guard means a reference never seeds the account whose
  creation prompted the user to enable it, only later ones — true before, and the
  copy says so.

- fac5a30: Back off node-relay reconnects, and tell the user when the node is unreachable.

  The wallet SDK opens the relay connection itself and its config type is
  `{ relayURL: URL }` — there is no retry knob to pass. Underneath,
  @polkadot/rpc-provider's `WsProvider` retries on a flat `RETRY_DELAY = 2_500`
  with no backoff and no ceiling. Against an endpoint that refuses connections
  that is 24 doomed handshakes a minute, indefinitely, and every other console
  message drowns in the wreckage — which is exactly how this was found, with
  preprod's node answering 403 from its load balancer to every caller.

  So the intervention sits one layer below the SDK, at the WebSocket constructor,
  which is ours inside the dedicated worker. While a backoff window is open the
  wrapper hands `WsProvider` a stub socket that never touches the network and
  reports failure when the window closes; its own 2.5s timer then fires and gets a
  real socket. Its retry loop is untouched and unaware — only the spacing between
  attempts that reach the wire has changed: 2.5s, 5s, 10s, 20s, 40s, then 60s
  ±20% jitter, roughly 7 attempts in the first two minutes and one a minute after.

  Deliberately never gives up. A node coming back must heal without the user
  knowing to click anything, so the curve flattens rather than stopping. Installed
  in the worker entry ahead of the lazy `wallet-host` import, since a swap after
  `WsProvider` has captured the global would be invisible to it; the build output
  is checked for that ordering.

  Surfaced as a banner on Home and the Send compose screen, shown to everyone
  rather than behind a flag: the relay is what broadcasts transactions, so a send
  will fail while it is down, and finding that out at the end of a signing flow is
  worse than being told up front. The copy says what is actually true — sync runs
  off the indexer, so balances stay correct and only sending is affected — and it
  avoids the phrase "rate limited", because a flat 403 is an allowlist or WAF
  block, not a throughput limit, and naming it as one sends people hunting a quota
  that does not exist. A new Developer mode setting (off by default) adds the
  endpoint, the HTTP status behind the failure, the attempt count and a live
  countdown; the warning itself is never gated, only how much it says.

  Classification needs a separate `fetch` probe because browsers withhold a failed
  handshake's HTTP status from JavaScript. It is rate-limited to once a minute so
  labelling a failure does not become a second source of traffic against an
  endpoint already in trouble. 401/403 reads as a refusal; anything else, or no
  answer, as plain unreachability — note that 405 is what a _healthy_ Midnight node
  answers to a plain GET on its WebSocket endpoint, so it must never be reported as
  a refusal.

- 2e02c37: Make the relay backoff actually engage — it was matching the wrong URL and doing nothing.

  The backoff only throttles sockets it recognises as the node relay, comparing the
  URL being dialled against the one the host names via `setRelayUrl`. Those two were
  never equal.

  `wallet-host` derived the relay URL from `network.nodeUrl` with a string replace,
  producing `wss://rpc.preprod.midnight.network`. Core builds the SDK's actual
  `relayURL` as `new URL(toWsUrl(network.nodeUrl))`, and URL normalisation appends
  the root path — so WsProvider dials `wss://rpc.preprod.midnight.network/`, with a
  trailing slash. The comparison failed on every socket, each one was passed
  straight through, and WsProvider's flat 2.5s retry ran exactly as it had before:
  24 failed handshakes a minute against an unreachable node.

  The mechanism was inert from the moment it shipped, while looking installed.
  `__mothWrapped` was present in the bundle and the install ordering was verified,
  so every check that had been run still passed.

  Both sides are now canonicalised through `new URL()`, so any spelling of one
  endpoint compares equal, and `setRelayUrl` is idempotent across spellings rather
  than resetting live backoff state when handed the same endpoint written
  differently.

  The new tests assert this through behaviour rather than internals: a recognised
  endpoint must return a stub on the construction following a failure, so the test
  counts dials that reach the wire. They were confirmed to fail against the previous
  code — earlier drafts passed either way, which is worse than no test.

- 730eeac: Copy the recovery phrase without its position numbers, and accept comma-separated phrases on import.

  The backup step showed the 24 words in a numbered grid with no copy button, so
  the only way to get the phrase out was to select the grid by hand — which takes
  the positions with it and yields "1 abandon 2 ability …", a string no import
  field accepts. Two changes: a **Copy phrase** button that writes the words
  space-separated and nothing else, and `select-none` on the position labels so
  hand-selection produces the same thing. The button is the supported path, but
  hand-selection is what people reach for first and it should not produce garbage.

  The copy routes through a shared `copySecret` helper, extracted from the Accounts
  reveal dialog, which clears the clipboard again after 60s — guarded by a read, so
  it only wipes the clipboard if it still holds the secret and never clobbers
  something copied since. A recovery phrase on a shared clipboard is readable by
  any other app on the machine, so a copy button is the start of an exposure
  window, not the end of an action; both places that expose key material now close
  it the same way.

  Import now parses with `splitSeedPhrase`, which accepts whatever the user
  actually has rather than one blessed format: spaces (a password manager),
  commas or semicolons (a spreadsheet or CSV export), and line breaks (a printed
  backup). It applies both to the "Paste phrase" button and to pasting into any
  single cell, which spreads across the grid from that cell on — previously a
  comma-separated paste landed as one unusable "abandon,ability,able" word.

  Bare numbers are dropped, so a numbered phrase round-trips back in. That is
  unambiguous rather than merely convenient: no BIP39 word is numeric, so a purely
  numeric token can only be an index. The guard is "purely numeric", not "contains
  a digit" — `abandon12` survives intact. Case is never folded: the caller
  validates against the wordlist, and quietly correcting case would hide a
  genuinely wrong word behind a guess.

  Also rewords the proving options. "Remote · Required for complex transactions"
  becomes "Dedicated local or remote-hosted proof server", and the explanatory text
  now says a proof server should be run locally (a Docker container is available)
  or by a trusted operator in a TEE with appropriate attestation — plus why it
  matters: proving discloses transaction details to whoever runs the server, so a
  remote one without attestation sees everything you prove.

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

- e88d552: Restore phase timings and relay-state replay in the sync service.

  The phase-timings instrument records nothing for sync messages or transaction
  stages, and a panel that reconnects after the service worker recycles never
  learns the relay is unreachable — it waits for the next probe, up to a minute
  later, showing no warning meanwhile.

  Both were lost in a conflict resolution. The commit that introduced them also
  touched `startSync`, where the incoming version called `getSnapshotOwner()` — a
  function that had not landed yet — so the whole file was resolved to the other
  side. That was right for `startSync` and wrong for everything else in the file.

  Restores the four `recordTiming` call sites (first-balances marker, sync
  messages, tx stages) and the cached `lastRelayState` replayed to each newly
  connected port, while keeping the snapshot-owner guard and the null-owner check
  that arrived later in the same function.

- ec20090: Show NIGHT balances as whole numbers when they have no fractional part.

  A balance of 120 NIGHT now reads `120 tNIGHT` rather than `120.000000 tNIGHT`,
  and thousands are grouped. Balances that do have a fractional part keep it, and
  sub-unit balances keep all six decimal places, so nothing is rounded away.
  Balances are never abbreviated to `1.2M` — unlike the DUST gauge, an exact
  figure matters when reading off what you hold.

  Applies to the Home balance header and asset rows, the DUST detail screen's
  backing-NIGHT line and registration prompts, and the Send flow's balance line and
  token picker.

  Minted-token amounts in the activity feed are grouped to match their asset rows,
  so a holding of 123,456 no longer reads `123,456` in one place and `+123456` in
  the other.

  Negative amounts now format with the sign in front. Balances are non-negative, so
  nothing on screen changes today, but the shared formatter derived its fractional
  part from an operation that keeps the sign, which rendered -1.5 as `-1.-5` — a
  trap for the next caller to pass it a delta.

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
- Updated dependencies [73d26e1]
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
  - @shieldedtech/moth-browser@0.1.1
