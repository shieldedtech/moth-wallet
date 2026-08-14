---
"@shieldedtech/moth-wallet": patch
"@shieldedtech/moth-extension": patch
---

Measure test coverage in CI, and share the core test fixtures.

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
