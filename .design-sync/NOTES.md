# design-sync notes — Moth wallet

- The design system is NOT a library package: it's `packages/extension/components/{ui,moth}` inside the WXT app `@shieldedtech/moth-extension`. No dist — the converter runs in synth-entry mode.
- `.design-sync/overrides/source-kit.mjs` fork (declared in `cfg.libOverrides`) does two things: excludes `components/screens/` from the synth entry (screens import the wallet SDK, which pulls the ledger WASM and kills esbuild with "No loader for .wasm"), and prefers JSDoc `@category` over path-derived groups (dirs are `ui/`/`moth/`, not the taxonomy). On re-sync, diff the fork against the staged `lib/source-kit.mjs` and merge upstream changes.
- `components/moth/dust.tsx` must keep its `@shieldedtech/moth-browser` import TYPE-ONLY (`dustView` lives in `lib/ui/dust-view.ts`). A value import there re-drags the WASM into the bundle.
- CSS is Tailwind v4, compiled by `.design-sync/build-css.sh` (= `cfg.buildCmd`, run from repo root) into `packages/extension/.ds-css/styles.css`. Tailwind scans the whole repo for used utilities — including `.design-sync/previews/` — so preview glue classes must be classes the repo (or a preview) actually uses. The script also copies @fontsource woff files next to the output because the inlined `@font-face` rules keep `url(./files/…)` unrebased.
- Component groups come from JSDoc `@category` tags in the sources (core/layout/money/feedback/setup/dapp).
- `DialogShell` has `cfg.overrides` `cardMode: single` (Radix portal overlay can't be presented in the grid view).
- Playwright: chromium-headless-shell v1228 (playwright installed in `.ds-sync/`).
- Subagent fan-out was unavailable (org monthly spend limit) — all 25 previews were authored in the main session.
- Known render warns: none — all 25 components have authored previews graded good.

## Feedback from the design-system project's validator (2026-07-07)

- **`templates/` in the project is project-authored — never write into it, never delete from it.** It holds 9 authored templates (activity, activity-empty, home, receive, send-not-enough-dust, send-success, settings, setup-network, token-selector) plus support DCs and per-folder ds-base.js, built by Claude Design to fill design gaps. It is not synced source. Anchored re-syncs can't touch it by construction (diff-scoped deletes); the risk is a no-anchor recovery whose reviewed-deletes step sees it as unknown files — it is not deletable.
- **Tailwind v4 utility-engine internals are not design tokens.** `build-css.sh` annotates every `--tw-*`, `--default-*`, `--ease-out`, and `--animate-spin` declaration with `/* @kind other */` (66 annotations as of this writing) so the app's token scanner skips them. They must stay where they are declared — `--tw-ring-shadow`/`--tw-ring-color` feed the box-shadow composition and hoisting them breaks focus rings. This generation supersedes 17 hand-added annotations in the project's `_ds_bundle.css`; the next sync intentionally overwrites that hand-edited file with the generated-annotated equivalent.
- Real theme tokens are correctly scoped (`:root` and `.dark`); the validator's "19 theme scopes" note about utility-class-scoped `--tw-*` declarations is informational only.

## Re-sync risks

- The compiled stylesheet depends on repo-wide class usage: deleting a screen can silently drop a utility a preview (or the design agent) relies on. After large UI refactors, re-run `build-css.sh` + full build and re-check the contact sheets.
- Preview sample data (amounts, addresses, seed words) is invented; if component APIs drift, previews fail to compile — the build prints `! preview build failed: <Name>` and that component drops to the floor card.
- lucide-react is bundled per-preview from the repo's node_modules; a version bump can change glyphs.
- The extension app itself keeps evolving; `@category` tags on new components are needed for correct grouping (untagged new components land in their dir-derived group).
- The target Claude Design project previously contained a designer-made copy of the design-tool DS + canvas files; this sync replaced `components/`, `tokens/`, `styles.css`, `_ds_bundle.js` and deleted the canvas duplicates, keeping `guidelines/`.
- The project's `_ds_bundle.css` may carry in-project hand edits between syncs (it did once, for @kind annotations). Overwriting it is correct as long as `build-css.sh` keeps generating the annotations; check the project validator's notes before assuming any other hand edit is disposable.
