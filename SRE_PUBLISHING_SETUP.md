# SRE Runbook — npm Publishing Setup (@shieldedtech)

This repo publishes packages to npm under the **`@shieldedtech`** scope using
[Changesets](https://github.com/changesets/changesets) and, in steady state, **npm Trusted
Publishing (OIDC)**:

| Package | Purpose | Published? |
| --- | --- | --- |
| `@shieldedtech/moth-wallet` | Core library | yes |
| `@shieldedtech/moth-cli` | CLI (`moth`) | yes |
| `@shieldedtech/moth-tui` | Terminal UI | yes |
| `@shieldedtech/moth-browser` | Browser library | **no — skipped for now** |

`@shieldedtech/moth-browser` is currently held back: it is marked `"private": true` in
`packages/browser/package.json`, so neither the bootstrap nor `release.yml` publishes it. To start
publishing it later, remove that line. Everything below concerns the **three** published packages.

These have never been published. npm Trusted Publishing can only be configured for a package that
**already exists**, so the first publish is a one-time **token bootstrap** (the `SHIELDED_NPMJS_TOKEN`
secret, run from a dedicated workflow). After that, publishing is automatic via OIDC and **no token
lives in CI**.

There are two committed workflows:

- **`release.yml`** — steady state. OIDC only, no token. You do **not** edit it.
- **`publish-bootstrap.yml`** — the one-time token publish. Deleted once bootstrap is done.

Work through the steps below **in order** — they resolve a chicken-and-egg (trusted publishing needs
the packages to exist; the packages need a publish to exist).

---

## Step 1 — Create the token and add it as a repo secret

1. **Org + token.** Ensure the **`@shieldedtech` npm org** exists and you are an owner. On npmjs.com →
   **Access Tokens** → create a **Granular Access Token** (or classic **Automation** token) with
   **read and write** on the `@shieldedtech` scope. Copy it once.

2. **Repo secret.** In `shieldedtech/moth-wallet` → **Settings → Secrets and variables → Actions →
   New repository secret**:
   - **Name:** `SHIELDED_NPMJS_TOKEN` (exact spelling — both workflows read it)
   - **Value:** the token from step 1.

---

## Step 2 — Get the workflows onto `main`

`publish-bootstrap.yml` is a `workflow_dispatch` workflow, so it can only be run once it exists on the
default branch. Merge this change to `main`.

> **Expected:** the automatic **Release** run on this merge will **fail** — there's a pending
> changeset, so it tries to publish a canary via OIDC, but the packages don't exist yet and no
> trusted publisher is configured. This is harmless; the next steps fix it. Ignore/​cancel that run.

---

## Step 3 — Run the bootstrap publish (token)

Actions → **"Publish bootstrap (one-time, token)"** → **Run workflow** (on `main`).

This runs the **same `changesets/action` as steady-state `release.yml`** — the only difference is
auth (the `SHIELDED_NPMJS_TOKEN` secret, passed as `NPM_TOKEN`, instead of OIDC). It publishes
`@shieldedtech/moth-{wallet,cli,tui}@0.1.0` with valid `^0.1.0` dependency ranges, pushes a git tag
per package, and creates a matching **GitHub Release** (`moth-browser` is skipped — see above). (This first publish has **no
provenance** — provenance is added automatically by `release.yml` once Trusted Publishing is on.)
Re-running is safe: already-published versions are skipped.

> The one pending changeset (`tricky-months-divide.md`) is empty and is cleared inside the bootstrap
> run so the action publishes the current `0.1.0` rather than opening a version PR. It still exists
> on `main` afterward — delete it in a follow-up commit to avoid a no-op "version packages" PR on the
> next push.

**Verify:**
```bash
for p in moth-wallet moth-cli moth-tui; do npm view @shieldedtech/$p version; done
```
Each should print `0.1.0`. There should also be three new tags / GitHub Releases. (`moth-browser` is
intentionally not published.)

---

## Step 4 — Configure npm Trusted Publishing

Now that the packages exist, add a GitHub Actions trusted publisher to **each** of the three
published packages on npmjs.com:

- npmjs.com → package → **Settings → Trusted Publishing → Add a trusted publisher → GitHub Actions**
- Fill in:
  - **Organization or user:** `shieldedtech`
  - **Repository:** `moth-wallet`
  - **Workflow filename:** `release.yml`  ← the steady-state workflow, **not** the bootstrap one
  - **Environment name:** *(leave blank)*

Repeat for `moth-wallet`, `moth-cli`, `moth-tui`. (Skip `moth-browser` — it isn't published yet; add
its trusted publisher when you remove `"private": true`.)

---

## Step 5 — Remove the token (switch to pure OIDC)

The token has done its job; steady state must not depend on it.

1. **Delete** the `SHIELDED_NPMJS_TOKEN` repo secret (Settings → Secrets and variables → Actions).
2. **Delete** the `.github/workflows/publish-bootstrap.yml` file (open a small PR).
3. On npmjs.com, **revoke** the bootstrap token.

From now on, CI publishes automatically via OIDC — no token, with provenance.

---

## After setup: how releases work (no SRE involvement)

1. A developer runs `yarn changeset`, commits the file in `.changeset/`, and merges to `main`.
2. The **Release** workflow opens a **"chore: version packages"** PR (version bumps + changelogs).
3. Merging that PR triggers the workflow's publish step, which publishes the new versions to npm via
   OIDC + provenance, pushes a git tag per package, and creates a GitHub Release.

The workflow's publish step also runs as a **no-op** on ordinary pushes (already-published versions
are skipped), so it never fails just because there's nothing to release.

While changesets are pending, every merge to `main` also publishes a **canary** snapshot under the
`canary` dist-tag. This needs **no extra setup** — it publishes the same package names via the same
trusted publishers configured in Step 4.

---

## Troubleshooting

- **Bootstrap fails with `ENEEDAUTH` / `E401`:** the `SHIELDED_NPMJS_TOKEN` secret is missing,
  misspelled, expired, or lacks read-write rights to the `@shieldedtech` scope. Re-check Step 1.
- **`ENEEDAUTH` / "requires you to be logged in" in `release.yml` (steady state):** the trusted
  publisher isn't configured for that package, or the **Workflow filename** in npm doesn't exactly
  match `release.yml`. Re-check Step 4 for every package. (If you haven't bootstrapped yet, that's
  Steps 2–3.)
- **`402 Payment Required` / "must sign up for private packages":** a package is being published
  private. The published packages set `"publishConfig": { "access": "public" }` — don't remove that.
  (This is distinct from `moth-browser`'s `"private": true`, which intentionally keeps it off npm.)
- **Provenance fails (steady state):** ensure the job has `id-token: write` (it does in the committed
  workflow) and npm ≥ 11.5.1 (provided by Node 24's bundled npm). As a last resort, remove
  `NPM_CONFIG_PROVENANCE` from the publish step to publish without provenance.
- **`Unsupported URL Type "workspace:"` on a consumer install:** a package was published with a
  `workspace:` range. This repo uses caret ranges to avoid that — do not reintroduce `workspace:`
  deps for published packages.
</content>
