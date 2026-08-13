#!/usr/bin/env bash
# Initialize a repo created from the shielded-template-repo template.
# - Replaces REPO_NAME placeholders in issue templates.
# - Optionally fetches the full Contributor Covenant v2.1 into CODE_OF_CONDUCT.md.
# - Stages an SPDX header snippet for new source files.
#
# Run once after cloning a fresh repo created from this template.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

# --- Prompt for repo name -----------------------------------------------------

default_name="$(basename "$repo_root")"
read -r -p "Repo name (default: $default_name): " repo_name
repo_name="${repo_name:-$default_name}"

if [[ ! "$repo_name" =~ ^[a-z0-9._-]+$ ]]; then
  echo "Invalid repo name: '$repo_name'. Use lowercase letters, digits, dot, dash, underscore." >&2
  exit 1
fi

echo "Using repo name: $repo_name"

# --- Replace REPO_NAME placeholders ------------------------------------------

# macOS sed and GNU sed differ on -i. Detect.
if sed --version >/dev/null 2>&1; then
  sed_inplace=(sed -i)
else
  sed_inplace=(sed -i '')
fi

# Files known to contain the placeholder. Add more as the template grows.
placeholder_files=(
  ".github/ISSUE_TEMPLATE/config.yml"
)

for f in "${placeholder_files[@]}"; do
  if [[ -f "$f" ]]; then
    "${sed_inplace[@]}" "s|REPO_NAME|$repo_name|g" "$f"
    echo "  updated: $f"
  fi
done

# --- Optional: fetch Contributor Covenant v2.1 -------------------------------

read -r -p "Fetch full Contributor Covenant v2.1 into CODE_OF_CONDUCT.md? [y/N]: " fetch_coc
if [[ "$fetch_coc" =~ ^[Yy]$ ]]; then
  coc_url="https://raw.githubusercontent.com/EthicalSource/contributor_covenant/release/content/version/2/1/code_of_conduct.md"
  if curl -fsSLo CODE_OF_CONDUCT.md "$coc_url"; then
    # Patch the contact placeholder in the canonical text.
    "${sed_inplace[@]}" "s|\[INSERT CONTACT METHOD\]|conduct@shielded.io|g" CODE_OF_CONDUCT.md
    echo "  fetched: CODE_OF_CONDUCT.md (Contributor Covenant v2.1)"
  else
    echo "  WARNING: failed to fetch CoC — leaving the pointer file in place." >&2
  fi
fi

# --- Suggest SPDX header for source files ------------------------------------

cat <<'EOF'

SPDX header snippet — paste into new source files (adjust comment syntax):

  SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
  SPDX-License-Identifier: Apache-2.0

EOF

# --- Next steps --------------------------------------------------------------

cat <<EOF
Done. Next steps:

  1. Edit CODEOWNERS — replace @shieldedtech/security and @shieldedtech/platform
     with the real team slugs for this project.
  2. Confirm SECURITY.md contact: security@shielded.io.
  3. Apply the "Base rules" ruleset (PR required, signed commits, etc.) using
     the canonical script in the private governance repo:
       git clone git@github.com:shieldedtech/open-source-governance.git
       ./open-source-governance/scripts/apply-ruleset.sh shieldedtech/$repo_name
     (Run AFTER the first push to main, so the branch exists remotely.)
  4. If this repo uses npm / cargo / docker / pip, uncomment the relevant block
     in .github/dependabot.yml.
  5. If this repo has compilable languages, populate the codeql 'language' matrix
     and flip the 'if: false' guard in .github/workflows/scan.yaml.
  6. Commit the changes:
       git add -A && git commit -s -m "chore: initialize from shielded-template-repo"

EOF
