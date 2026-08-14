## Company rules

This repository follows the company-wide engineering floor in
[`shieldedtech/agent-rules`](https://github.com/shieldedtech/agent-rules). When
that repository is available as a sibling checkout, read
`../agent-rules/AGENTS.md` and the applicable files under
`../agent-rules/rules/` before acting. Repository-specific guidance here may
add constraints but does not replace or weaken those rules.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan at
`specs/001-isomorphic-wallet-tool/plan.md`
<!-- SPECKIT END -->

## Extension UI copy

User-facing strings in `packages/extension` live in typed i18n catalogs, never
as literals in components — a guard test fails CI otherwise. See "UI text
(i18n)" in `packages/extension/README.md` before adding or changing copy.

## Release guardrails

- Use `.github/workflows/release.yml` and npm Trusted Publishing for releases;
  do not publish packages manually or add an npm token to CI.
- Keep the published packages restricted and the repository private until the
  linked `shieldedtech/open-source-governance` case records a final GO.
- `packages/browser` is private and must not be published.
- Add a Changeset for package behavior changes and verify lint, build, and tests
  before opening a release-related PR.
