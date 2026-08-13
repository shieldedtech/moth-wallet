# Branch reconciliation ledger

Consolidating `feature/address-book`, `feat/tui-daemon-v8`, `fix/tui-circuit-call-proof`,
`fix/tui-stale-balance-on-switch`, `feature/theme-dark-mode`, and `feature/i18n`
onto the latest `main`, on branch **`feat/fix-bobs-silliness`**.

Standing decisions (apply everywhere):
- **D1 — Either prover.** Keep `main`'s selectable `createProofProvider` (WASM *or* server)
  over v8's server-only `httpClientProofProvider`. Wins every prover collision.
- **D2 — Option A key model.** Adopt v8's derive-and-drop `walletKeys` as the single core
  key model; the raw seed is derived once and dropped, never threaded past that point.
- **D3 — Both API shapes.** Keep both seed-based (`sendTokens`/`designateForDust`/…) and
  keys-based (`*WithKeys`) variants. Connector write paths (`build`/`estimate`/`balance`/
  `swap`) are keys-only.
- **D4 — Package names.** `@shieldedtech/moth-*`; SDK family `@midnightntwrk/wallet-sdk`
  (no hyphen). `ledger-v8`/`midnight-js`/`compact-*` stay hyphenated.
- **D5 — Coverage.** Every reconciled behavior gets happy + failure unit tests.

Legend for "Winner": **main** / **v8** / **addr** (address-book) / **theme** / **blend** (union).

---

## Stage 1 — TUI+CLI daemon (v8) → main  · commit `dd95e40`

| File | Winner | What was kept / why |
|---|---|---|
| `core/sync/operations.ts` | blend | main's `combinedTransfers` + `submitWithRetry`/`isAlreadyImported`; v8's `deriveWalletKeys` + `*WithKeys` write paths; seed wrappers kept (D2, D3) |
| `core/sync/wallet-sync.ts` | blend | main's async `SyncStateStore`/`WalletSyncOptions`; v8's SDK-dedup (`Custom*Wallet` + `deduping*Builder`); `startWalletSync(keys)` (D2) |
| `core/sync/preseed.ts` | blend | main's async store (`loadRefState`); dropped v8's `node:fs` pre-seed bridge; `walletKeys` via `deriveWalletKeys` |
| `core/contract/call.ts` | main+v8 | main's selectable `createProofProvider` (D1); v8's `walletKeys` opts + `toPositionalArgs`. Documented why it's not the unversioned-payload bug |
| `core/contract/deploy.ts` | main+v8 | main's `resolveProverConfig`/`ensureProverReady` (D1); v8's `walletKeys` + `constructorArgs`/`initialPrivateState` |
| `core/contract/maintenance.ts` | main+v8 | main's `createProofProvider` (D1); v8's `walletKeys`; dropped v8's `proofClient` param (unused) |
| `core/proof/provider.ts` | main | selectable prover (server via SDK `httpClientProvingProvider` → ledger versioned `prove`) |
| `core/index.ts` | blend | union of main + v8 exports |
| `cli/base-command.ts` | blend | main's prover config + v8's daemon client imports |
| `cli/commands/{deploy,mint}.ts` | blend | main's `describeProver`/`resolveProverConfig` (D1) + v8's args/FT helpers; dropped dead `TransactionBuilder`/`ProofClient` |
| `cli/commands/dust/{register,deregister}.ts` | v8 | `*WithKeys` variants |
| `cli/commands/transfer.ts` | v8 | `SyncedWallet`/`WalletBalances` types |
| `tui/hooks/useBalance.ts` | blend | v8's `walletKeys` dep + main's `proverKey`/`nodeUrl` deps (D1 re-sync on prover change) |
| `tui/hooks/useWallet.ts`, `tui/utils/balance.ts` | blend | v8 `WalletKeys` type; dropped duplicate `NIGHT_TOKEN_ID` import |
| package.json / tui/package.json / yarn.lock | blend | D4 names; unioned resolutions; lockfile regenerated |
| `core/tests/.../operations.test.ts` | — | migrated `estimateTransferFee` test to keys; assert exact dust key (D5) |

Verification: core 136/136, tui 62/62, cli integration skip (no devnet); `moth-ft.compact` recompiles.

## Stage 2 — TUI fixes  · commit `3344dbd`

| Item | Winner | Note |
|---|---|---|
| `90af501` circuit-call proof | reconciled tree | NOT cherry-picked — subsumed by D1's selectable prover; cherry-picking would revert D1 |
| `38c3548` balance-on-switch | reconciled tree | NOT cherry-picked — reset-to-`EMPTY_STATE` already present in `useBalance` |
| 2 changesets | added | accurate release notes for both fixes |

## Stage 3a — address-book merge + Option A extension migration  · commit `49830ca`

| File | Winner | What was kept / why |
|---|---|---|
| `core/sync/wallet-sync.ts` | blend | kept `removeWalletSyncArtifacts` (HEAD) **and** added `clearDustSyncCache` (addr) — two distinct fns |
| `core/index.ts`, `browser/index.ts` | blend | export `clearDustSyncCache`, `deriveWalletKeys`, `WalletKeys` |
| `ext/lib/background/settings.ts` | blend | HEAD's `parseEndpoints` (selectable prover, D1) + addr's `parseAutoLock`; dropped addr's server-only `isEndpoints` |
| `ext/lib/background/handlers.ts` | blend | HEAD's `!proverConfigsEqual` network-change check (D1) inside addr's `const networkChanged = …; if` structure |
| `ext/sidepanel/App.tsx` | blend | HEAD `useSelectedProverType` + addr `accountLabel`/`ownDustAddress` |
| `ext/screens/SendFlow.tsx` | blend | addr's multi-output `Pending` + HEAD's `proverType`/`provingMethodStatus`; exported `Pending` |
| `ext/screens/DustDetail.tsx` | blend | addr's mode-aware `Pending` + HEAD's `proverType` |
| `ext/lib/offscreen/wallet-host.ts` | blend | HEAD's `ensureProver` (D1) + build/submit + `transactionHash` (submit-hash fix); addr's `trackOp`/`noteSubmitted`/`dustAddress`/`deregisterDust`; **migrated seedHex→walletKeys (D2)** |
| `ext/tests/{settings,network-switch,dust-detail,send-flow}.test.ts(x)` | blend | assert selectable prover **and** auto-lock/multi-output |
| `ext/src/**` (v8-era `sync-service`, `early-connect`) | deleted | orphaned duplicates from the Stage-1 squash; broke typecheck |
| `core/wallet/manager.ts` | new | `exportSeedHex` — the one deliberate D2 exception, for the extension offscreen key-holder (WASM keys can't cross the message boundary) |

Verification: core 148, extension 213, all workspaces build; extension typecheck clean.

## Stage 3-fix — KDF write + latent bugs + regression test  · commit `73e4353`

| Item | Winner | Note |
|---|---|---|
| `manager.ts` KDF-upgrade write | fix | wrote to `wallets/<name>` (phantom) → now `walletKey(name)`; upgrade now persists |
| `manager.ts` `loadConfig` | fix | shallow `{...DEFAULT_CONFIG}` shared the `wallets` array → deep-copy; surfaced by new tests |
| `ext/tests/wallet-host-unlock.test.ts` | new | guards the "correct password not recognized" regression (walletUnlock must source seedHex from `exportSeedHex`) |

## Stage 3b — theme-dark-mode merge  · commit `d6247a5` (dark-mode scheme later reworked in `ee38590`)

New theme feature (clean adds, non-conflicting): `lib/ui/theme.ts`
(`initAppearance`/`loadAppearance`/`saveAppearance`, toggles `dark`/`colorblind`
on `documentElement`), `theme.test.ts`, and `initAppearance()` wired into all
three entrypoints (setup / sidepanel / approval).

| File | Winner | What was kept / why |
|---|---|---|
| `ext/lib/messaging/protocol.ts` | HEAD | keep addr's `addressBook*` methods (theme predates them) |
| `ext/lib/background/handlers.ts` | HEAD | keep addr's address-book imports + handlers |
| `ext/screens/Settings.tsx` | blend | **both** Security/auto-lock (HEAD) **and** Appearance/theme+colorblind (theme) sections; imports auto-merged |
| `ext/screens/Accounts.tsx` | HEAD | keep addr's `onSwitched` (unlockTarget) design; dropped theme's divergent `switching`-spinner version (unused after body took HEAD) |
| `ext/sidepanel/App.tsx` | HEAD | keep `useSelectedProverType` + addr's `setUnlockTarget` switch; dropped theme's `markActive` onSwitched (would've duplicated the prop) |
| `ext/screens/SendFlow.tsx` | HEAD | keep addr's multi-output flow; dropped theme's single-token `editToken`/Review rows |
| `ext/lib/ui/client.ts` | fix | removed a duplicate `useTokenNames` the auto-merge concatenated (no marker; TS2323/2393) |

Verification: extension typecheck clean, **219 tests pass** (theme's `theme.test.ts` added), bundle builds.

## Stage 3c — i18n merge + hard-coded-string migration  · commit `bfeb8c0`

feature/i18n branched before address-book AND the selectable prover, and it ships
a `no-hardcoded-strings.test.ts` lint plus de/es/fr catalogs. So every screen split
two ways, and the lint forced migrating all strings the newer features added.

| File | Winner | What was kept / why |
|---|---|---|
| `protocol.ts`, `handlers.ts` | HEAD | keep addr's `addressBook*` methods (i18n predates them) |
| `lib/ui/token-list.ts` | i18n | i18n's `t('tokens_*')` is the complete translated equivalent |
| `lib/ui/activity-view.ts` | blend | HEAD's batch-transfer logic + i18n keys; added `activity_send(ing|)Transfers` |
| `screens/Home.tsx`, `Approval.tsx`, `Receive.tsx` | i18n | pure `t()` wrap of identical logic |
| `screens/Unlock.tsx` | blend | keep HEAD's account-switch title; added `unlock_unlockAccount`/`unlock_switchHint` |
| `screens/NetworkConfig.tsx` | HEAD+t | keep selectable-prover UI (D1); added `network_proving`/`wasm`/`proofServer*`/`provingHelp` keys |
| `screens/Accounts.tsx` | blend | keep HEAD account-switch (void/unlockTarget); i18n `t()` on labels/dialogs |
| `screens/Settings.tsx` | blend | keep HEAD auto-lock+addresses; i18n theme; added `settings_autoLock*`/`sectionSecurity`/`sectionAddresses` |
| `screens/SendFlow.tsx` | HEAD→migrated | took HEAD's multi-output (`--ours`), then i18n-migrated (subagent); +21 `send_*` keys |
| `screens/DustDetail.tsx` | HEAD→migrated | took HEAD's register/deregister flow (`--ours`), then i18n-migrated (subagent); +21 `dust_*` keys |
| `components/moth/address-picker.tsx`, `screens/AddressBook.tsx` | migrated | address-book components predated the lint; wrapped in `t()`, new `addressBook` catalog (20 keys) |
| `entrypoints/setup/App.tsx` | blend | i18n wrap; added `setup_accountName*` |
| `entrypoints/sidepanel/App.tsx` | HEAD | keep `useSelectedProverType` + `setUnlockTarget` switch |
| `lib/ui/client.ts` | fix | removed the duplicate `useTokenNames` the auto-merge re-concatenated |
| `lib/i18n/messages/*` | blend | new `addressBook.ts` domain; +88 keys total across catalogs |
| `public/_locales/{de,es,fr}` | placeholder | 88 new keys added with **English placeholder text** (pending real translation — see follow-ups) |

Verification: extension typecheck clean, **228 tests pass** (incl. `no-hardcoded-strings` lint + `i18n` catalog test), all workspaces build.

Follow-ups (not blockers): the 88 new de/es/fr entries are English placeholders and need real translation; a changeset for the i18n + address-book + theme feature set.

## Stage 4 — whole-repo green + coverage + changesets  · commit `cab9424` (translation follow-up still in draft)

- **Changeset reconciliation — shipped** (`cab9424`). The `.changeset/` set now carries
  one entry per reconciled behavior.
- **Translation follow-up — drafted** (`cab9424`). The de/es/fr catalogs were
  re-drafted with safe-string localizations and their state is tracked in
  `packages/extension/lib/i18n/TRANSLATION-STATUS.md`; some entries are still
  drafts pending native review (see follow-ups under Stage 3c).
- Whole-repo build+test / coverage top-up rode along with the ongoing
  reconciliation branch (latest `main` merged in `16a9d01`).
