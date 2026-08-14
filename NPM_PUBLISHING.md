# npm Publishing Runbook (@shieldedtech)

This repository publishes three private packages under the `@shieldedtech`
scope using Changesets and npm Trusted Publishing:

| Package | Purpose | npm access |
| --- | --- | --- |
| `@shieldedtech/moth-wallet` | Core library | Restricted |
| `@shieldedtech/moth-cli` | CLI (`moth`) | Restricted |
| `@shieldedtech/moth-tui` | Terminal UI | Restricted |

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

Trusted Publishing works for restricted packages. npm adds provenance
automatically when both the repository and package are public; restricted
packages remain without public provenance.

## Release lifecycle

1. A developer adds and commits a Changeset with `yarn changeset`.
2. A push to `main` makes `release.yml` open or update the
   `chore: version packages` PR.
3. Pending Changesets also publish a snapshot under the `canary` dist-tag.
4. After review, merging the version PR makes the same workflow publish the
   stable versions, push tags, and create GitHub Releases.

The workflow uses `MIDNIGHTCI_PACKAGES_WRITE` only for GitHub operations needed
to open the Changesets PR. npm publishing does not use that secret.

## Public release gate

Changing repository visibility or npm package access requires a final GO in the
private open-source governance case.

Until then:

- Keep all three npm packages restricted.
- Do not change `publishConfig.access` from `restricted`.
- Do not make the repository public.

After final approval, change package access through the reviewed release
procedure and rerun the governance audit against the exact `main` SHA that will
be published.

## Verification

Use an npm account with access to the private `@shieldedtech` packages:

```bash
for package in moth-wallet moth-cli moth-tui; do
  npm view "@shieldedtech/${package}" version dist-tags --json
done
```

An `E404` can mean the package is private and the current npm identity does not
have access. Confirm with `npm whoami` and the package's npm access settings.

After a publish, verify that the GitHub Actions log contains no `NODE_AUTH_TOKEN`
or `NPM_TOKEN` environment entry and that all expected versions share the
intended dist-tag.

## Troubleshooting

- **`ENEEDAUTH`, `E401`, or `EOTP`:** confirm the trusted publisher is present
  on every package and exactly matches `shieldedtech/moth-wallet` and
  `release.yml` with no environment.
- **OIDC exchange failure:** confirm the job runs on a GitHub-hosted runner, has
  `id-token: write`, and installs the reviewed npm 12.0.2 CLI.
- **Unexpected `E404`:** verify the npm identity can read the restricted package.
- **`Unsupported URL Type "workspace:"`:** inspect the packed manifest and
  ensure Changesets rewrites internal workspace dependencies before publishing.
- **Public provenance missing:** provenance appears only after both the GitHub
  repository and npm package are public.

## Credential cleanup

After recording successful automatic OIDC publish evidence:

1. Delete the `SHIELDED_NPMJS_TOKEN` GitHub Actions secret if it still exists.
2. Revoke the npm recovery token.
3. Set npm publishing access to require 2FA and disallow traditional tokens.

These are administrative changes and must be performed only after verifying the
Trusted Publishing path.
