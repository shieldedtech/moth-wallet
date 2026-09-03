# @shieldedtech/moth-wallet

## 0.13.0

### Minor Changes

- a17b719: Show what a dApp transaction takes from the wallet before the user approves it.
  
  When a connected dApp calls `balanceSealedTransaction` or
  `balanceUnsealedTransaction`, the wallet is asked to cover whatever the dApp's
  transaction is short of — and the approval screen said only "Network fee: paid
  in DUST". The user was approving a spend without being told the amount or the
  token. The screen now lists, per token, what the wallet has to supply ("You
  pay") and any surplus it collects back ("You get back"), plus the number of
  contract calls when there are any. If the transaction cannot be decoded, it
  says so in a visible warning rather than showing nothing.
  
  The amounts come from the transaction itself, before anything is balanced,
  booked or spent: core gains `summarizeTransaction` /
  `summarizeConnectorTransaction` (`sync/tx-summary.ts`), which sums the ledger's
  `Transaction.imbalances(segment)` over the guaranteed section and every intent.
  A negative imbalance is what the wallet must put in; a positive one is change.
  The sign convention is pinned by a test against the real ledger. Fees are not
  included — they are only known once the wallet has balanced and proven its own
  segment, and are always paid in DUST.
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
- 0508a38: Four CLI fixes found by a manual test pass, none of which the test suite could see.
  
  **Amounts are parsed strictly (#63).** `moth transfer` used `parseFloat` and
  `Math.round`, and `parseFloat` keeps whatever prefix it understands: `1,5` was
  accepted as **1 NIGHT**, losing a third of the value with no warning; `0.0000001`
  rounded to **zero base units** and was submitted as a transfer that moved nothing
  and still paid a fee; `1e3` became 1000 NIGHT; `1abc` became 1. A shared
  `parseNightAmount` in core now refuses all of them, in BigInt, with a message
  naming what is wrong — and `daemon transfer` already did it this way, so the two
  paths finally agree.
  
  **`moth transfer` can select a token (#62).** It hardcoded `NIGHT_TOKEN_ID`, so a
  wallet holding anything else could spend it only through `daemon transfer
  --token-id`. Same flag name and default here. The positional amount stays a NIGHT
  decimal and is refused for other tokens, directing to `--amount` in raw base units
  — mis-scaling a token by NIGHT's 10⁶ would be worse than refusing.
  
  **`moth wallet export-phrase` exists (#59).** `WalletManager.exportPhrase` and
  `exportSeedHex` have always been in core, and the extension exposes them, but no
  CLI command did. So the CLI had no backup path — a phrase was shown once at
  `wallet generate` and never again — no way to move a wallet between machines, and
  no way to recover a seed for a keystore you hold the passphrase to. Confirmed by
  default and refused non-interactively without `--yes`, following `wallet remove`.
  A wallet imported from a hex seed says so rather than presenting a seed as a
  phrase.
  
  **`wallet address` takes `--wallet` (#60).** It was the only command in the CLI
  requiring `--name`, which made it the only one that could not act on the active
  wallet: `wallet use w1` then `wallet address` failed with "Missing required flag
  name". `--name` remains as an alias.
  
  **`dust register` distinguishes empty from done (#58).** `designateForDust`
  returns `null` both when every UTXO is already designated and when there are no
  NIGHT UTXOs at all, and the command reported the first for both — vacuously true
  of an empty wallet, and read as success. An unfunded wallet now gets "No NIGHT to
  designate" and a non-zero exit.
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
- 3e131e2: Detect an indexer renumbering instead of silently syncing from the wrong place.
  
  Sync cursors are indexer-assigned event sequence numbers, and nothing ties an id
  to a block — `DustLedgerEvent` carries only `id`, `raw`, `maxId` and
  `protocolVersion`. So when the same URL starts serving a differently-numbered
  stream, a stored cursor names a different event and the sync resumes at the wrong
  point without erroring. The only guard was a string comparison of `indexerUrl`,
  which by definition cannot see a backend swap behind an unchanged name — and it
  lived in the extension's background, so the CLI and TUI had no check at all.
  
  This has already happened on preprod. The default indexer had a 22-wide hole in
  its dust id space; the host now serving that name numbers contiguously, so cursors
  written before the change sit 22 events too high. The pre-seed reference committed
  for the extension stores dust cursor `1431375`, which under the current numbering
  is 22 events beyond the state the snapshot holds — verified against the live
  indexer, where that id now yields digest `3f3576deb45ad350` while the event the
  reference actually stopped at yields `11c8cf9fd5a736f2`.
  
  A cursor is now stored with a **witness**: the hash of the event found at that id.
  On resume the id is re-read and compared. Same event means the numbering is
  unchanged; a different event means it moved and the cursor is refused, failing
  closed to a genesis sync — the direction ADR-0003 already establishes as always
  safe.
  
  A witness rather than one global indexer fingerprint, because a fingerprint has to
  be sampled at a fixed id and any id below the point where two numberings diverge
  returns the *same* event from both. Sampled at preprod's hole (989781), old and
  new both return the event new calls 989781 — old's first existing id at or above
  that probe was 989803, the same event — so a fingerprint there would have matched
  across the exact cutover it existed to detect. The divergence point is not
  knowable in advance; a witness has no such blind spot, because it asks only about
  the id the cache actually depends on.
  
  Three paths are gated: the warm read verifies before handing a reference to any
  wallet, a build records witnesses for the cursors it stops at, and
  `refreshEmptyRefCache` refuses to resume across a mismatch — resuming would carry
  the old numbering forward into a reference that then looks freshly built, which
  destroys the evidence.
  
  Scope. Only shielded and dust are witnessed: they ride the global ledger-event
  numbering and are the two the preprod change moved, where unshielded is keyed by
  address. Per-wallet caches are not yet gated — normal sync persistence is written
  by the SDK's own serialization rather than through `saveCachedState`, so covering
  those needs a separate seam. A reference with no witness is treated as
  unverifiable rather than invalid, so upgrading does not force a chain walk on
  everyone at once; new references carry witnesses and the population converges.
- e31eaf8: Record a witness per cursor in exported references, and refuse a bundle without one.
  
  A published reference records cursors that are indexer-assigned event sequence
  numbers, so its correctness depends on an indexer that the bundle says nothing
  about. That is how the preprod bundle stayed in use after the numbering underneath
  it moved: the bytes were intact, the checksums matched, and the cursors had
  quietly stopped naming the events they were written for.
  
  `export-preseed.mjs` now reads the event at each cursor and records its hash in
  the manifest under `witnesses`, alongside `height` and the per-part sizes. It
  refuses to export at all if a cursor cannot be witnessed — including the case
  where the indexer returns no event at or after the cursor, which means the
  reference is *ahead* of the indexer it is being exported against and is itself the
  renumbering signal.
  
  The extension's installer requires them. A manifest without a witness for shielded
  and dust is rejected, and the witnesses are written to the store before the height
  — the height is what marks a reference usable, so a reference that reads as usable
  without its witnesses is one that skips verification.
  
  The asymmetry with local references is deliberate. A witnessless reference already
  on disk is treated as unverifiable rather than invalid, because the alternative
  forces every existing user into a chain walk on upgrade. A witnessless *bundle* is
  an artefact we control and can re-cut, so refusing it costs one slower first sync
  and trusting it costs a wallet silently resuming at the wrong event. The bundle
  currently in the repository has no witnesses and will therefore no longer install;
  a reference rebuilt from genesis against the current indexer replaces it.
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
- c1c462e: **Reveal no longer offers a recovery phrase for accounts that do not have one.**
  
  The first version accepted either choice and then answered with the seed for a
  seed-restored account, because that account genuinely has no phrase — BIP-39's
  phrase-to-seed step is one-way, so one cannot be worked back out. Correct
  values, but it read as the selection being ignored: pick "recovery phrase", get
  a hex seed, with the explanation arriving only after the password was entered.
  
  The phrase option is now disabled for those accounts, with the reason shown
  next to it, and the dialog opens on the seed instead.
  
  To grey it out *before* asking for a password, the UI has to know which artifact
  an account holds. `WalletInfo.backupKind` (`'mnemonic' | 'seed'`) records it:
  `generate` and `import` write `'mnemonic'`, `importFromSeed` writes `'seed'`.
  
  `undefined` on accounts written before the field, and deliberately not defaulted
  — guessing `'mnemonic'` would tell a seed-imported account it has a phrase,
  which is the bug this exists to prevent. Unknown leaves the option open and lets
  the revealed value explain itself as before. **`unlock` backfills the field**,
  since the keystore payload (`seed:<hex>` versus a mnemonic) is what distinguishes
  them and the password is the only thing that reveals it — so an account someone
  actually opens stops being unknown after one unlock. The write happens only when
  the stored value is missing or wrong, alongside the address backfill already
  there, so a normal unlock does not touch storage.
- 04f1aa4: **`undeployed` replaces `local` as the local devnet network.** Every interface now
  offers it, including the extension, which could not select it before.
  
  The two were duplicate presets for the same thing. `undeployed` is the id the
  Midnight tooling, `docs/TESTING.md`, and this repo's own README instructions all
  use for the local stack, and it points at the node port that stack listens on —
  `9944`. `local` pointed at `9933`, which nothing in the documented stack serves,
  so selecting **Local** in the extension connected to a closed port. It has been
  that way since the first commit.
  
  `local` was kept out of the extension's picker by a comment claiming the wallet
  could not derive addresses for `undeployed`. That was false: `mn_addr_undeployed1…`,
  `mn_dust_undeployed1…` and `mn_shield-addr_undeployed1…` have always derived, and
  `address-parity`'s network loop stopping at `qanet` is why nothing contradicted it.
  The loop now covers `undeployed` and `stagenet`, and a new test holds
  `SUPPORTED_NETWORKS` equal to the keys of `DEFAULT_NETWORKS`, so a preset no
  interface can reach — or an offered network with no preset — fails the suite.
  
  **Breaking, with a migration.** `local` is gone from `SUPPORTED_NETWORKS` and
  `DEFAULT_NETWORKS`, and the extension rejects it on save. Read paths resolve it via
  `canonicalNetworkId`, exported from core: the extension's stored selection, a
  wallet's meta record, the TUI's `lastNetwork`, `--network local`, and
  `createMothBrowser({ network: 'local' })` all continue to work and land on
  `undeployed`. Per-network birthdays and endpoint overrides move across with it, so
  a migrated wallet keeps its pre-seed shortcut instead of resyncing from genesis.
  Stored records are rewritten lazily, only when something else is already saving
  them. `local` stays in `ALL_NETWORKS` so addresses already handed out still resolve.
  
  Sync caches are keyed by network, so a migrated account resyncs once under the new
  key — correct, since the node URL genuinely changes — and its old entries are left
  behind rather than cleaned up.
  
  Also fixed alongside: the four localhost indexer fallbacks pointed at
  `http://localhost:8088` without the `/api/v4/graphql` path the indexer client posts
  queries to, and the README's network table listed `devnet` as localhost, omitted
  `undeployed`, and gave qanet hostnames (`rpc.qanet.dev.midnight.network`) that do
  not resolve. Mainnet stays out of both the table and the `--network` reference:
  the CLI refuses it and the extension keeps it out of the picker, so documenting
  its endpoints only invites someone to try.

### Patch Changes

- b49c96d: Bound the sync-engine teardown, and stop a wedged one from pinning everything
  behind it.
  
  `facade.stop()` closes the wallet SDK's submission service, which first awaits
  the Polkadot client the facade was built with. That client is created with
  `ApiPromise.create({throwOnConnect: false})`, so against a node that never
  answers it neither resolves nor rejects — WsProvider simply keeps retrying. The
  stop therefore had no failure path, and every caller inherited the hang. The
  trigger is a node URL that does not answer, which is exactly the state a user is
  in while editing one, Local network being the common case.
  
  Three consequences, all fixed here:
  
  - **Settings → Network's Save button spun for ever and discarded the edit.**
    `saveNetworkConfig` awaited the stop before persisting, so the save neither
    completed nor failed and the next attempt started from the same broken
    endpoint. Settings are now written before the engine is touched and rolled back
    if the switch fails, and a stop the offscreen document never answers closes that
    document — Chrome destroys it without its cooperation, which is the only
    teardown that reaches a wedged one.
  - **The idle teardown never closed the offscreen document,** so an idle wallet
    kept its worker and WASM heap alive instead of letting the service worker
    suspend.
  - **Locking never freed the worker holding key material,** because `lockNow`'s
    forced teardown waited on the same stop.
  
  `facade.stop()` is now raced against a 5s bound. The offscreen `syncStop` no
  longer waits unboundedly on a start that may never finish, and still stops that
  engine whenever it does come up, so an abandoned start cannot keep syncing behind
  a new one.
- f736ebd: Settings → Network gains "Clear cache and resync".
  
  A local network that goes down and comes back as a new chain from genesis
  leaves the wallet holding state for a chain that no longer exists: the
  account's serialized sync state, its pending submissions, and the network's
  pre-seed reference that every fresh sync is seeded from. The engine cannot
  tell, and the only ways out were switching indexer URLs or removing the
  account. The new action, behind a confirmation, stops sync, drops all of that
  for the active account on its network, clears the cached balance snapshot so
  the loading screen shows, and starts syncing again from the start of the
  chain. Nothing is spent.
  
  Core gains `clearEmptyRefCache(networkId, store)` (`sync/preseed.ts`), which
  removes the reference's state parts, height, cursor witnesses and mnemonic and
  forgets the in-process memo — without the last, a worker that had already
  verified the reference would keep handing the stale one out.
- 2dabc50: Make `moth config` usable, and add smoke coverage for the class of bug it was.
  
  `config` declared an optional positional argument (`action`) ahead of a required
  one (`key`). @oclif/core rejects that outright — with `action` absent, a single
  value is ambiguous between an action and a key — so every invocation failed at
  spec validation and the command body never ran. `action` is now required, which
  changes no working behaviour because nothing worked.
  
  Nothing caught this because no test invoked the command. Two probes now cover the
  class:
  
  - **Positional order, checked statically from source.** This is the one that
    bites: reverting the fix produces `config: required "key" follows optional
    "action"`.
  - **A `--help` sweep over all 35 commands**, which catches a broken flag
    definition, a bad example, or an import that throws on load.
  
  Worth recording why it takes two. `--help` does not validate positional-argument
  order: with the bad spec in place, `moth config --help` prints help perfectly
  happily while bare `moth config` reports "Invalid argument spec". So the help
  sweep would not have caught the bug that prompted it, and the order rule has to be
  checked separately. Invoking every command bare would catch it, but would also
  run them.
- 9afd580: Refuse mainnet at the `--network` flag, not in one of its consumers.
  
  The refusal lived inside `BaseCommand.getNetworkConfig`, and twelve commands never
  call it — including both that create wallets. `moth wallet generate --network
  mainnet` derived mainnet addresses, wrote a keystore, printed a recovery phrase
  and exited 0, with no warning shown. A guard in one consumer is not a guard; it is
  a convention that holds wherever someone remembered it.
  
  It now hangs off the `--network` flag that every command inherits through
  `baseFlags`, so no command can take a network id without it. `getNetworkConfig`
  keeps the check as defence in depth, for an id arriving from stored config or from
  a caller assembling flags itself, and both now route through one
  `assertNotMainnet`.
  
  Verified across the paths the issue did not cover: `wallet generate`, `wallet
  import`, `wallet use` and `tui` all now print the warning and exit 1 without
  writing a keystore, while `--network preprod` is untouched.
  
  Also guards `config set default-network mainnet`, which is the second way a
  network id enters the CLI — `WalletManager` falls back to `config.defaultNetwork`
  for a wallet with no network of its own, so a stored value reaches the same code
  paths without `--network` ever being used. Note that path is currently unreachable
  for an unrelated reason: `moth config` declares an optional argument before a
  required one, which oclif rejects, so every invocation of that command fails
  before it runs. Filed separately.
- b49c96d: Read the birthday back, so a CLI or TUI wallet can actually pre-seed.
  
  The birthday was written and never read. `startWalletSync`'s pre-seed gate is
  `(isNewWallet || birthday)`, and no CLI command passed either — eleven of them
  stopped at `walletName`, and the TUI hook passed `isNewWallet` but no birthday,
  so the guard `emptyRef.height <= birthday` could never be reached. The effect was
  silent: `moth balance -n preprod -v` showed no pre-seed line at all and dust began
  at 0%, with the reference sitting unused.
  
  Every sync call site now passes it, resolved through a new
  `WalletManager.birthdayOn(name, networkId)`. Per network on purpose: `list()`
  resolves against the wallet's own `meta.network`, so a sync driven by `--network`
  was reading a height belonging to a different chain, or nothing at all. It never
  throws — a wallet with no meta asserts nothing, and "no claim" means scan from
  genesis, which is slow but never wrong.
  
  Guarded by a test that walks the AST of every `startWalletSync` call in the CLI
  and TUI and fails any that omits the birthday, since nothing else would notice
  this regressing. Verified by deliberately dropping the argument.
- c2f8b73: Re-cut the pre-seed bundles from genesis, and add one for qanet.
  
  The preprod bundle recorded dust cursor `1431375`, written under the indexer's old
  numbering. Under the numbering now served, that id names an event 22 positions
  later than the state the snapshot holds, so every wallet seeded from it resumed
  past 22 dust events — no error, just missing generation history (#40).
  
  All three references were rebuilt from genesis rather than refreshed, because a
  refresh resumes from the stored cursor and would have carried the old numbering
  forward into a bundle that then looked freshly built:
  
  | Network | Height | Build | Dust cursor |
  | --- | --- | --- | --- |
  | preprod | 2,203,416 | 55 min | 1,449,958 (was 1,431,375) |
  | preview | 519,470 | 3 min | 141,062 |
  | qanet | 2,314,786 | 14 min | 346,693 |
  
  Each manifest now carries a witness per cursor, so a consumer can tell whether the
  numbering it was written under still holds — these are the first bundles that can
  be verified rather than trusted, and the first that the installer will accept.
  
  qanet ships for the first time. It costs 140 KB, not the several megabytes preprod
  does: its chain is longer but has far fewer dust events, and dust is what makes a
  reference large. The control that offers on-device warming probes which networks
  ship a reference rather than listing them, so no code changed to add it.
- b49c96d: Move the pre-seed commands from `moth dust preseed` to `moth preseed`.
  
  DUST is why the pre-seed matters — the 4.9 MB blob, the ~1.4M events, the tens of
  minutes, where shielded and unshielded take seconds — which is what put it under
  `dust`. But that describes the motivation, not the thing: the pre-seed writes all
  three sub-wallet caches, and a reference is per-network machine state in `~/.moth`
  shared by every wallet there, whereas `moth dust` groups per-wallet token
  operations. A command tree should say what a thing is, and someone whose first
  sync is crawling searches for "preseed" rather than reasoning their way to DUST.
  
  Settled while the command had not shipped, so the rename costs no compatibility.
  
  Each action is now a real subcommand — `preseed status|import|refresh|build|export`
  — instead of one command taking an action argument. `--timeout` therefore belongs
  to `build` and `--force` to `import`, rather than every flag hanging off the group
  with "(build only)" in its description, and each gets its own `--help`. The group
  carries an oclif topic description; without one the help listed the whole group
  under whichever subcommand sorted first.
- b49c96d: Require all three parts of a pre-seed reference, and drop `node:zlib` from core.
  
  Two findings from review on the CLI/TUI parity work.
  
  **A missing part was as damaging as a corrupt one.** Both `exportReference` and
  `importReference` checked only dust, so a bundle without shielded state imported
  the other two over an existing reference and moved the height key with them. The
  store was left holding shielded at the old height and the rest at the new one — a
  mixture that never existed on chain, reported as ready by
  `loadUsableRefStates` because the height key still looked consistent, and that
  inflated height then feeding the `emptyRef.height <= birthday` guard, seeding
  wallets whose birthday fell between the two. Both functions now require every
  part: export returns null, import refuses and names each missing file.
  
  **`node:zlib` had no business in core.** Nothing in the browser or extension
  packages imported `preseed-portable` yet, but it is re-exported from core's
  barrel — and that barrel reaches 36 Node builtins where the browser package's
  walked graph reaches none, so one careless import would have carried zlib into
  every dependent DApp bundle. Compression now goes through `CompressionStream` and
  `DecompressionStream`, which Node 18+ and every current browser provide, so the
  module is genuinely isomorphic rather than allow-listed as an exception. Gzip
  level is not selectable through that API, so bundles written here compress
  slightly less than `scripts/export-preseed.mjs` does at level 9; sizes are
  recorded in the manifest either way, and decompression is level-agnostic.
- 9be5669: Show what a transfer can actually spend.
  
  A synced wallet reported 500 NIGHT and refused a 10 NIGHT transfer with
  `Insufficient funds`. Both figures were true and neither was reconcilable from
  outside the wallet.
  
  The displayed balance counts coins reserved by transactions in flight, and does
  so deliberately — dropping them flashes the balance to zero mid-send. But the SDK
  spends from `availableUtxos` alone, so the number shown was never the number that
  could be spent, and nothing surfaced the difference.
  
  `moth balance` now prints the split when anything is reserved, and stays quiet
  otherwise:
  
  ```
  NIGHT:
    unshielded: 500.000000  (500000000 STARS)
      available:  0.000000  ← what a transfer can use
      reserved:   500.000000  (a transaction in flight holds these)
  ```
  
  JSON gains `unshieldedAvailable` and `unshieldedReserved` beside the existing
  fields, so nothing reading it today breaks. The transfer's insufficient-funds
  path names the number that blocked it, and says nothing when a reservation was
  not the cause.
  
  Nothing new is computed — `WalletBalances.coins` already carried the split.
  
  This makes the state visible; it does not stop reservations outliving their
  transactions. A wallet already in that state still needs its sync cache cleared.
- ea1793d: Report sync progress that is neither invented nor erased.
  
  Two defects in how progress reached the surfaces, close enough together in
  `extractBalancesPartial` that fixing them apart would mean resolving the same
  twenty lines twice.
  
  **A partial emission erased a sub-wallet.** Each sub-wallet's coins and its
  progress were read inside a single `try`, and the coin loops reached into the
  state without the optional chaining used one line above on the balances:
  
  ```ts
  const sb = state.shielded?.balances;              // guarded
  for (const c of state.shielded.availableCoins) {  // not guarded — throws here
  …
  subProgress.shielded = {applied, total};          // never reached
  ```
  
  An emission carrying no slice for a part threw in the loop and skipped the
  progress assignment, leaving `{applied: 0, total: 0}` — which `fraction()` treats
  as **complete**, correctly for a sub-wallet with genuinely nothing to apply and
  catastrophically for one whose slice was simply absent. The TUI alternated about
  once a second between real figures and `synced · 0 / 0` with no balance. Coins
  and progress now read separately, all six coin loops are guarded, and each part
  carries its previous value forward when an emission says nothing about it;
  progress does not go backwards inside a session. A genuinely 0/0 part still
  counts as complete rather than stalling the overall figure.
  
  **The ETA assumed every sync starts at zero.** `etaSeconds` was
  `elapsedMs / percentage - elapsedMs`, which treats cumulative progress as this
  session's work. Dust resumes from cache constantly, so a run that restored at
  ~65% and then ran 152s was read as "67% in 152s" — fifteen times the real rate.
  Measured on preprod it promised 1m15s at 67% and 2m23s at 81% against a true
  ~10m, and the estimate *climbed* as elapsed time corrected the fiction. The rate
  now comes from a per-session baseline: the same inputs give 41m and 12m19s,
  falling as the run proceeds. Below 0.2 points of movement it reports nothing,
  since an admitted unknown beats a number derived from noise.
  
  Both bugs predate the CLI/TUI parity work, which only made the first visible by
  putting per-sub-wallet counters on screen. The daemon and extension read the same
  balances.
- 316ca82: Document `moth transfer` as it actually works.
  
  The README showed `moth transfer <amount> NIGHT --to <addr>` on two rows. That form
  does not parse — `transfer` declares one positional and rejects the second with
  `Unexpected argument: NIGHT`. It was the documented invocation, so it was the first
  thing a new user would type.
  
  Corrected to `moth transfer [<amount>] [--to <addr>]`, and the rows now say what
  was previously stated nowhere: the in-process command is NIGHT-only, with the
  token hardcoded and no flag to change it. A row for `moth daemon transfer` covers
  the path that *can* move other tokens, including the distinction between
  `--amount` (raw smallest units, any token) and `--night` (a decimal converted at
  10⁶ STARS, refused for anything but NIGHT).
  
  Docs only. Whether the in-process command should grow token selection is the open
  half of #62.
- 89f34aa: Stop the sync before freeing the keys when the TUI quits.
  
  Quitting printed a wall of WASM errors over the exiting terminal, once per live
  sync:
  
  ```
  Wallet.Other: Error while applying sync update
    cause: Error: Dust secret key was cleared
      at DustLocalState.replayEventsWithChanges
  ```
  
  The quit handler called `lockAll()` and then `exit()`, zeroing the
  `DustSecretKey` in the WASM heap while the dust sync was still mid-batch. The
  only `stop()` lived in an unmount cleanup, ran after `exit()`, and was
  fire-and-forget, so the sync's next batch reached for a key that no longer
  existed.
  
  `useBalance` now exposes an awaited `stop()` — unsubscribe, await the facade's
  stop, bounded by a timeout so a sync that will not settle cannot keep the TUI
  open — and both quit paths await it before locking.
  
  Nothing was corrupted: the wallet was exiting and its state was already
  persisted. It simply looked like a crash every time, and would have buried a real
  error.
  
  The non-quit unmount path (Ctrl-C, a crash, the process ending) now stops before
  locking as well, which narrows the window rather than closing it — a React
  cleanup cannot await, so a batch already inside the WASM call can still find the
  key gone.

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
