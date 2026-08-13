# Contributing

Thanks for your interest in contributing to a Shielded Technologies project. This document covers the contribution process for any repository under [`shieldedtech`](https://github.com/shieldedtech).

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. By signing off on a commit, you certify that you wrote the change or have the right to submit it under the project's license.

Sign off every commit:

```bash
git commit --signoff -m "<your message>"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer. We enforce this via the DCO GitHub App — PRs with unsigned commits will not merge.

Set up automatic sign-off:

```bash
git config --global format.signOff true
```

## Signed commits

Commits to `main` must be cryptographically signed. Branch protection enforces this server-side — unsigned commits cannot merge. If you push an unsigned commit and the PR's required check fails with "Unsigned commits", you'll need to re-sign and force-push to your fork branch.

### Quick setup — SSH signing (recommended)

SSH signing is the lightest option: reuses your existing SSH key, no GPG agent to manage. Requires git 2.34+ and a configured SSH key on your GitHub account.

```bash
# Point git at your existing SSH key
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgSign true
git config --global tag.gpgSign true

# Tell git to trust your own key for verification
mkdir -p ~/.config/git
echo "$(git config --get user.email) $(cat ~/.ssh/id_ed25519.pub)" \
  >> ~/.config/git/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
```

Then on GitHub: **Settings → SSH and GPG keys → New SSH key** → pick **Key type: Signing Key** (not Authentication). You can re-add the same key with both purposes.

Verify it works:

```bash
git commit -S --allow-empty -m "test: signed commit"
git log --show-signature -1   # should print "Good signature"
```

### Alternative — GPG signing

```bash
gpg --full-generate-key                    # follow the prompts, ed25519 is fine
gpg --list-secret-keys --keyid-format=long # note the key ID after "sec ed25519/"
git config --global user.signingkey <KEY_ID>
git config --global commit.gpgSign true
git config --global tag.gpgSign true
gpg --armor --export <KEY_ID>              # paste this into GitHub → Settings → SSH and GPG keys → New GPG key
```

If you're on macOS and the gpg-agent doesn't survive across terminal sessions, add `export GPG_TTY=$(tty)` to your shell rc.

### Auto-enable in this repo

After cloning, run:

```bash
direnv allow        # if you use direnv; .envrc enables signing locally
```

or apply it manually one-off:

```bash
git config --local commit.gpgSign true
git config --local tag.gpgSign true
```

### Troubleshooting

- **"error: gpg failed to sign the data"** — usually a stale gpg-agent. `gpgconf --kill gpg-agent` and retry. On macOS: `brew install pinentry-mac` and set `pinentry-program /opt/homebrew/bin/pinentry-mac` in `~/.gnupg/gpg-agent.conf`.
- **PR shows "Unverified" badge** — your signing key is set in git but not registered on GitHub. Re-check the SSH/GPG key page.
- **Signed but DCO check fails** — signing and sign-off are different. You also need `--signoff` (or `format.signOff = true`) to add the `Signed-off-by:` trailer.

GitHub's own guide covers edge cases (Smart Cards, S/MIME, multiple identities): <https://docs.github.com/authentication/managing-commit-signature-verification>.

## Getting started

1. **Search existing issues and PRs** before opening a new one.
2. **Read the project README** — every repo has its own setup steps.
3. **Open a draft PR early** if the change is non-trivial. It's cheaper to align on direction before code is written.

## Submitting issues

Use the issue templates in `.github/ISSUE_TEMPLATE/`. They cover:

- **Bug report** — observed behavior, expected behavior, reproduction steps.
- **Feature request** — what you want, why, expected outcome.
- **Documentation improvement** — what's wrong or missing.

Security issues go through [SECURITY.md](./SECURITY.md), not the public issue tracker.

## Code contribution process

1. **Fork** the repository and create a branch. Prefix with your handle for clarity: `alice/add-foo`.
2. **Make focused commits.** One logical change per commit, clear subject line.
3. **Write tests.** New behavior needs unit tests; bug fixes need a regression test.
4. **Update documentation** in the same PR as the code change.
5. **No `--force` pushes** once review has started. Add fixup commits instead — reviewers can re-review just the delta. Squash before merge if requested.
6. **Pass CI.** All scan, lint, and test jobs must be green before merge.
7. **Request review** from CODEOWNERS.

## Coding standards

Each repo defines its own style guide. Defaults across the org:

- **TypeScript/JavaScript:** Biome or ESLint + Prettier — config lives in the repo.
- **Rust:** `rustfmt` + `clippy -D warnings`.
- **Compact (Midnight smart contracts):** `compact format` + the language version pinned in the project.
- **Commit messages:** Conventional Commits is encouraged but not required.

## License header

Add this header to new source files. Use the comment syntax for the file's language.

```text
SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
SPDX-License-Identifier: Apache-2.0
```

The full Apache-2.0 boilerplate lives in [`LICENSE`](./LICENSE); the SPDX identifier is sufficient in individual files.

## Where to ask questions

- **General questions:** GitHub Discussions on the relevant repo.
- **Bug or feature:** an issue using the appropriate template.
- **Security:** see [SECURITY.md](./SECURITY.md).
- **Code of conduct:** `legal@shielded.io`.
