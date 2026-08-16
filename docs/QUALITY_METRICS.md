# Quality metrics

The repository keeps the raw reports in GitHub Actions artifacts and publishes
the two public-facing metrics separately:

- **Coverage:** the `Coverage (advisory)` job uploads `coverage/lcov.info` to
  Codecov when the repository secret `CODECOV_TOKEN` is configured. Codecov
  supplies the percentage badge and historical coverage view.
- **OpenSSF Scorecard:** `scorecard.yml` publishes the signed SARIF result to
  the Scorecard API and uploads the same result to GitHub code scanning. The
  Scorecard badge reports a score from 0 to 10, not a percentage.

## One-time maintainer setup

1. Install the Codecov GitHub App for `shieldedtech/moth-wallet`.
2. Create the repository's Codecov upload token and store it as the Actions
   secret `CODECOV_TOKEN`.
3. Run the coverage workflow on `main` and confirm that the Codecov report and
   badge resolve.
4. Run `OpenSSF Scorecard` once from Actions and confirm the published result at
   the Scorecard viewer URL in the README.

The Scorecard workflow uses GitHub's OIDC token for result publication. No
long-lived cloud or signing secret is stored in the repository. Coverage remains
advisory until a measured baseline is accepted and thresholds are deliberately
introduced.
