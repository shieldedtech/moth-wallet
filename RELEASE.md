# Release Process

This repository uses [Changesets](https://github.com/changesets/changesets) for automated versioning and publishing to npm.

## Setup (One-time)

Publishing uses **npm Trusted Publishing (OIDC)** under the `@shieldedtech` scope — there is no
long-lived npm token in CI. Configuring and verifying each package's trusted publisher is an SRE
task documented in
**[SRE_PUBLISHING_SETUP.md](./SRE_PUBLISHING_SETUP.md)**. Developers do not need an npm token.

## Creating a Release

### Step 1: Create a Changeset

When you make changes that should be released, create a changeset:

```bash
yarn changeset
```

This will prompt you to:
1. Select which packages have changed
2. Choose the semver bump type (major/minor/patch)
3. Write a summary of the changes

Commit the generated changeset file:
```bash
git add .changeset/
git commit -m "chore: add changeset"
git push
```

### Step 2: Automated Release

When you push to `main`, the GitHub Action will:

1. **If changesets exist**: Create a "Version Packages" PR that:
   - Bumps versions in package.json
   - Updates CHANGELOG.md files
   - Removes consumed changeset files

2. **When you merge the PR**: Automatically publish the stable release to npm

3. **While changesets are still pending** (before the Version Packages PR is merged): every push to
   `main` also publishes a **canary** snapshot of the affected packages under the `canary` dist-tag,
   versioned like `0.2.0-canary.<timestamp>-<sha>`. Install the latest pre-release with:
   ```bash
   npm install @shieldedtech/moth-wallet@canary
   ```
   Canary versions are throwaway snapshots — they never become `latest` and create no git tags.

## Release Workflow

```
┌─────────────────┐
│ Make changes    │
│ yarn changeset  │
│ git commit/push │
└────────┬────────┘
         │
         v
┌─────────────────────────┐
│ GitHub Action runs      │
│ Creates "Version" PR    │
└────────┬────────────────┘
         │
         v
┌─────────────────────────┐
│ Review & merge PR       │
└────────┬────────────────┘
         │
         v
┌─────────────────────────┐
│ Publishes to npm        │
│ Creates git tags        │
└─────────────────────────┘
```

## Package Access

The three published packages are **restricted** while the repository completes the open-source
governance process. Do not change npm access or repository visibility until the governance case
records a final GO decision.

## Semver Guidelines

- **Major** (1.0.0 → 2.0.0): Breaking changes
- **Minor** (1.0.0 → 1.1.0): New features, backwards compatible
- **Patch** (1.0.0 → 1.0.1): Bug fixes, backwards compatible

## Manual Publishing

Manual publishing is unsupported because it bypasses the reviewed GitHub Actions identity and
release evidence. Fix or rerun the workflow. Any emergency exception requires explicit SRE approval
and must preserve the open-source governance gate.

## Consuming @shieldedtech/moth-wallet in Other Projects

Add to your project:

```bash
npm install @shieldedtech/moth-wallet
# or
yarn add @shieldedtech/moth-wallet
```

Usage:
```typescript
import { deployContract, createWallet } from '@shieldedtech/moth-wallet';
```

## Troubleshooting

### "You must be logged in to publish packages" / `ENEEDAUTH` in CI

In steady state publishing is OIDC-based. Make sure:
1. The job has `id-token: write` permission (see `.github/workflows/release.yml`).
2. A **trusted publisher** is configured for the package on npmjs.com pointing at this repo and
   the `release.yml` workflow (see [SRE_PUBLISHING_SETUP.md](./SRE_PUBLISHING_SETUP.md)).
3. npm is ≥ 11.5.1 in the workflow (provided by Node 24's bundled npm).

### "You do not have permission to publish"

Confirm the package has a trusted publisher that exactly matches this repository and workflow, and
that the publishing job is running from the permitted branch and GitHub-hosted environment.

### "Package already exists"

Version was already published. Check:
```bash
npm view @shieldedtech/moth-wallet versions
```
