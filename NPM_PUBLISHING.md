# npm Publishing Runbook (@shieldedtech)

This repository publishes three public packages under the `@shieldedtech`
scope using Changesets and npm Trusted Publishing:

| Package | Purpose | npm access |
| --- | --- | --- |
| `@shieldedtech/moth-wallet` | Core library | Public |
| `@shieldedtech/moth-cli` | CLI (`moth`) | Public |
| `@shieldedtech/moth-tui` | Terminal UI | Public |

`@shieldedtech/moth-browser` is excluded because
`packages/browser/package.json` marks it private. The extension and demo
workspaces are also not published.

## Trusted Publisher configuration

Each published package must have this GitHub Actions trusted publisher on
npmjs.com:

- Organization or user: `shieldedtech`
- Repository: `moth-wallet`
- Workflow filename: `release.yml`
- Environment name: blank
- Allowed action: `npm publish`

The workflow runs on a GitHub-hosted runner, installs the reviewed npm 12.0.2
CLI, and grants `id-token: write`. The automatic jobs do not receive an npm
publish token: npm exchanges the workflow's OIDC identity for a short-lived,
package-scoped credential.

The repository and all three packages are public, so npm adds provenance to
Trusted Publishing releases automatically.

## Release lifecycle

1. A developer adds and commits a Changeset with `yarn changeset`.
2. A push to `main` makes `release.yml` open or update the
   `chore: version packages` PR.
3. Pending Changesets also publish a snapshot under the `canary` dist-tag.
4. After review, merging the version PR makes the same workflow publish the
   stable versions, push tags, and create GitHub Releases.

The workflow uses the repository's built-in `GITHUB_TOKEN` to open the
Changesets PR. It does not use a PAT, GitHub App credential, or npm token.

When `GITHUB_TOKEN` creates or updates the version PR, GitHub creates its
`pull_request` workflow runs in an approval-required state. A maintainer must
select **Approve workflows** on the version PR before its required checks run.
This is GitHub's documented recursion protection for automated pull requests.

## Public release approval

The private open-source governance case recorded its final GO on 2026-08-17.
The approved npm publication scope is limited to `@shieldedtech/moth-wallet`,
`@shieldedtech/moth-cli`, and `@shieldedtech/moth-tui`.

Approval evidence is recorded in
[`shieldedtech/open-source-governance#19`](https://github.com/shieldedtech/open-source-governance/issues/19).
Any repository visibility change, npm access change, or expansion to another
workspace requires a new reviewed governance decision.

The browser, extension, mock dapp, and template/demo workspaces remain private
and must not be published.

## Verification

Query the public registry directly:

```bash
for package in moth-wallet moth-cli moth-tui; do
  npm view "@shieldedtech/${package}" version dist-tags --json
done
```

An `E404` now indicates unexpected registry or package configuration. Confirm
the registry URL, package name, and npm access settings before retrying.

After a publish, verify that the GitHub Actions log contains no `NODE_AUTH_TOKEN`
or `NPM_TOKEN` environment entry and that all expected versions share the
intended dist-tag.

## Troubleshooting

- **`ENEEDAUTH`, `E401`, or `EOTP`:** confirm the trusted publisher is present
  on every package and exactly matches `shieldedtech/moth-wallet` and
  `release.yml` with no environment.
- **OIDC exchange failure:** confirm the job runs on a GitHub-hosted runner, has
  `id-token: write`, and installs the reviewed npm 12.0.2 CLI.
- **Unexpected `E404`:** verify the registry URL and confirm the package remains public.
- **`Unsupported URL Type "workspace:"`:** inspect the packed manifest and
  ensure Changesets rewrites internal workspace dependencies before publishing.
- **Public provenance missing:** provenance appears only after both the GitHub
  repository and npm package are public.
- **Release commit mismatch:** rerun the workflow for the commit that introduced
  the package version; never publish that version from a later source revision.
- **Version PR checks await approval:** select **Approve workflows** on the PR,
  then wait for all required checks before review and merge.

## Credential cleanup

After recording successful automatic OIDC publish evidence:

1. Delete the `SHIELDED_NPMJS_TOKEN` GitHub Actions secret if it still exists.
2. Revoke the npm recovery token.
3. Set npm publishing access to require 2FA and disallow traditional tokens.

These are administrative changes and must be performed only after verifying the
Trusted Publishing path.
