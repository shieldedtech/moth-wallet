# @shieldedtech/moth-extension

Browser extension for the Moth reference wallet (Midnight Network), built with [WXT](https://wxt.dev) + React. The primary UI surface is the browser **side panel** (Chrome `sidePanel` API / Firefox sidebar); dApp approval requests open small dedicated windows.

> **USE AT YOUR OWN RISK.** This is experimental software provided AS-IS with no warranty. Not audited. For development and testing purposes only — do not use with real funds on mainnet.

## Develop

```bash
yarn workspace @shieldedtech/moth-extension dev            # Chrome, HMR, auto-loads the extension
```

> **Firefox:** currently blocked. `@midnight-ntwrk/ledger-v8` initializes its WASM with top-level await, which requires an ES-module background; Firefox has no module background scripts ([bug 1803950](https://bugzilla.mozilla.org/show_bug.cgi?id=1803950)). Firefox support needs the WASM loaded via `.wasm?init` (async, no TLA) — tracked as a post-MVP task. The `dev:firefox`/`build:firefox` scripts are kept for when that lands.

Or load manually: `yarn workspace @shieldedtech/moth-extension build`, then chrome://extensions → "Load unpacked" → `packages/extension/.output/chrome-mv3`.

Click the toolbar icon to open the side panel.

## UI text (i18n)

All user-facing copy lives in typed message catalogs — never as literals in
components. A guard test (`tests/no-hardcoded-strings.test.ts`) scans every
component's JSX and fails CI on hardcoded prose, and `t()` only accepts keys
that exist, so a key without a message is a compile error.

To add new UI text:

1. Add the message to the catalog file for your screen's area in
   `lib/i18n/messages/` (e.g. `send.ts` for the Send flow), keyed
   `<area>_<camelCase>`: `send_reviewTransfer: 'Review transfer'`. Dynamic
   values use positional placeholders in one whole sentence —
   `send_balanceOf: 'Balance $1 $2'` — never concatenated fragments.
2. Render it with `t` from `lib/i18n`:
   `t('send_reviewTransfer')` or `t('send_balanceOf', [amount, symbol])`.
3. That's it. The English `_locales/en/messages.json` is emitted from the
   catalogs on every build (see `wxt.config.ts`), so it cannot drift, and
   outside the extension runtime (vitest) `t()` falls back to the bundled
   English — tests keep asserting real copy.

A new UI area gets its own catalog file: create it in `lib/i18n/messages/`,
register it in `messages/index.ts`, and prefix its keys with the file name
(`tests/i18n.test.ts` enforces the prefix and rejects cross-file collisions).
Truly non-translatable literals (address-format hints, token glyphs) are
allowlisted with a reason in `tests/no-hardcoded-strings.test.ts`.

To add a language, check in `public/_locales/<lang>/messages.json` with the
same keys; Chrome selects it by browser locale. German, French and Spanish
ship today — the "shipped locales" test in `tests/i18n.test.ts` holds every
checked-in locale to the exact key set, matching `$n` placeholders, and
untranslated brand terms (Midnight, NIGHT, DUST, Moth, shielded/unshielded).

## Test the dApp connector

The standalone mock dapp in `packages/mock-dapp` exercises
`window.midnight.moth` without depending on extension source or UI code. With
the extension running, start it from a second terminal:

```bash
yarn dev:mock-dapp
```

See [`packages/mock-dapp/README.md`](../mock-dapp/README.md) for the covered API
methods and transaction-safety notes.

## Build / package

```bash
yarn workspace @shieldedtech/moth-extension build          # .output/chrome-mv3
yarn workspace @shieldedtech/moth-extension build:firefox  # .output/firefox-mv2
yarn workspace @shieldedtech/moth-extension zip            # store-ready zips
```

## Create a GitHub release

Merge the reviewed version and extension changes to `main`. The extension CD
workflow then validates the package version, builds the production Chrome
extension, creates the matching `moth-extension-v<version>` tag, and creates the
GitHub release with `moth-extension-<version>-chrome.zip`. Operators do not push
the release tag manually.

## Notes

- **tsconfig deviation:** this package extends WXT's generated `.wxt/tsconfig.json` (path aliases, extension globals) instead of the repo's `tsconfig.base.json` — the base config's `rootDir`/`outDir`/`declaration` assumptions don't fit a Vite-bundled app. Run `yarn workspace @shieldedtech/moth-extension compile` for a typecheck.
- Wallet keys live encrypted (ChaCha20-Poly1305) in IndexedDB via `@shieldedtech/moth-browser`; the unlocked seed is held only in `browser.storage.session` (memory-backed, cleared when the browser exits). Locking is explicit — lock button, account removal, network switch; there is no inactivity auto-lock for now (its timer used to kill a sync in progress).
- The proving method selected under Settings → Network is used for wallet and
  dApp transactions. Local WASM proving is recommended for simple transactions,
  such as token transfers. Complex transactions, such as contract calls, require
  a proof server (default `http://localhost:6300`). WASM parameters and built-in
  keys are fetched on demand from the Midnight SDK's key source.
- The dApp connector implements the [Midnight dApp connector API](https://docs.midnight.network/api-reference/dapp-connector) as `window.midnight.moth`, including a functional `getProvingProvider` backed by the wallet's selected proving method.
- When a dApp asks the wallet to balance a transaction it built
  (`balanceSealedTransaction` / `balanceUnsealedTransaction`), the approval
  screen lists what the transaction takes from the wallet — every token and
  amount the wallet has to supply, and any change it gets back — read from the
  transaction's own per-segment imbalances (`Transaction.imbalances`) before
  anything is spent. Fees are not in that list: they are only known once the
  wallet has balanced and proven its segment, and are always paid in DUST. If
  the transaction cannot be decoded, the screen says so instead of showing an
  empty list.
