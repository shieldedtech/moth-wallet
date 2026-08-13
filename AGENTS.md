<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan at
`specs/001-isomorphic-wallet-tool/plan.md`
<!-- SPECKIT END -->

## Extension UI copy

User-facing strings in `packages/extension` live in typed i18n catalogs, never
as literals in components — a guard test fails CI otherwise. See "UI text
(i18n)" in `packages/extension/README.md` before adding or changing copy.
