# Shielded Technologies Template Repository

GitHub template for new Shielded Technologies repositories. Pre-wires the baseline files, security scanning, and contributor policies that every project under [`shieldedtech`](https://github.com/shieldedtech) is expected to have.

## What you get

| File | Purpose |
| --- | --- |
| `LICENSE` | Apache-2.0. |
| `SECURITY.md` | Disclosure policy + private vulnerability reporting flow. |
| `CONTRIBUTING.md` | Contribution process, DCO, SPDX header template. |
| `CODE_OF_CONDUCT.md` | Contributor Covenant v2.1. |
| `CODEOWNERS` | Default review ownership for the meta-files. |
| `CHANGELOG.md` | Keep-a-Changelog seed. |
| `SUPPORT.md` | Splits "I have a question" from "I found a bug". |
| `NOTICE` | Attribution file (Apache-2.0 convention). |
| `THIRD_PARTY_NOTICES.md` | Stub for third-party license disclosures. |
| `.editorconfig` | Indent / line-ending baseline. |
| `.gitattributes` | LF line endings, binary markers. |
| `.gitignore` | macOS / Linux / Windows OS junk, common editors, Rust (`target/`), TypeScript/Node (`node_modules/`, `dist/`, `.env*`), Compact `managed/` output. |
| `.envrc` | Local git config (signed commits). Opt-in via `direnv allow`. |
| `.github/ISSUE_TEMPLATE/*` | Bug, docs, feature templates + `config.yml`. |
| `.github/PULL_REQUEST_TEMPLATE/` | PR checklist. |
| `.github/dependabot.yml` | GitHub Actions updates by default; language ecosystems commented for opt-in. |
| `.github/release.yml` | Auto-categorized release notes. |
| `.github/workflows/scan.yaml` | Shared org scan action (`midnightntwrk/upload-sarif-github-action`, SHA-pinned): OpenGrep (SAST) + OSSF Scorecard + Checkov (IaC) + zizmor (Actions) + Trivy (vuln) + gitleaks (secrets) → SARIF to code scanning. CodeQL runs separately via GitHub Default Setup. |
| `scripts/init-new-repo.sh` | One-shot setup for a new downstream repo (SPDX headers, find/replace). |
| `docs/adr/` | Architecture Decision Records — `0000-template.md` + index. Copy the template for each new decision. |

## Using this template

1. Click **Use this template → Create a new repository** in the GitHub UI, or:

   ```bash
   gh repo create shieldedtech/<your-repo> --template shieldedtech/shielded-template-repo --public
   ```

2. Clone the new repo and run the init script:

   ```bash
   ./scripts/init-new-repo.sh
   ```

   It will prompt for the repo name, replace `<REPO_NAME>` placeholders, and stage the SPDX header for new files.
3. Configure repo settings (see [`docs/repo-settings.md`](#repo-settings-checklist) below).

## Repo settings checklist

Set these on every new repo. The template can't enforce them — GitHub settings live outside the working tree.

**Shortcut**: after pushing the first commit to `main`, run the canonical scripts
from a clone of the (private) governance repo — they are deliberately not vendored
here, so audited repos can't carry drifted copies:

```bash
git clone git@github.com:shieldedtech/open-source-governance.git
./open-source-governance/scripts/apply-ruleset.sh shieldedtech/<your-repo>   # mirror "Base rules"
./open-source-governance/scripts/audit-repo.sh shieldedtech/<your-repo>      # verify the baseline
```

Public repos are also re-audited on a schedule by the governance repo's
re-certification workflow; failures go to the Open Source Committee.

- **Settings → General → Template repository**: ON (only for this template itself).
- **`Base rules` ruleset on `main`** (what `apply-ruleset.sh` mirrors):
  - Pull request required: 1 approval, code-owner review, stale-review dismissal,
    last-push approval, review-thread resolution.
  - Code scanning (CodeQL) and code-quality gates.
  - Require signed commits.
  - Block force-push (`non_fast_forward`) and branch deletion.
    (No required-status-check, linear-history, or tag rules — add repo-specific
    required checks, e.g. the DCO App check, separately.)
- **Settings → Code security**:
  - Dependabot alerts + security updates: ON.
  - Secret scanning + push protection: ON.
  - Private vulnerability reporting: ON.
- **Actions → General → Workflow permissions**: read-only default; workflows opt-in via `permissions:`.
- **Rulesets**: disallow tag deletion; require signed tags on `v*`.

## SPDX header

Every source file should carry this header. The init script stages it for you.

```text
SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
SPDX-License-Identifier: Apache-2.0

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

Use the comment syntax appropriate to the file format (`//`, `#`, `<!-- -->`, etc.).

## Pinning convention for GitHub Actions

All third-party actions in this template are pinned to a full commit SHA, with the human-readable tag in a trailing comment. Downstream repos must follow the same rule — version tags can be moved; commit SHAs cannot.

```yaml
- uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0  # v7.0.0
```

`dependabot.yml` keeps the SHAs current on a weekly cadence.

## Provenance

This template started as a fork of [`midnightntwrk/midnight-template-repo`](https://github.com/midnightntwrk/midnight-template-repo) (Apache-2.0). Significant changes: Contributor Covenant v2.1 upgrade, CLA → DCO, the org-maintained `midnightntwrk/upload-sarif-github-action` scan (OpenGrep, OSSF Scorecard, Checkov, zizmor, Trivy, gitleaks) with CodeQL via Default Setup, additional baseline files, and Shielded Technologies branding.
