# Interactive setup for a manual test run. MUST BE SOURCED, not executed:
#
#   source scripts/test-setup.sh
#
# A child process cannot export into its parent, so running this as ./script
# would set everything up and then throw it away.
#
# Configures the proof server, the network, an optional throwaway HOME, and the
# `moth` alias. Uses environment variables rather than `moth config set`, for two
# reasons: env vars need no writable state, so they work identically against a
# throwaway HOME; and `moth config` is currently unusable on this branch — it
# declares an optional positional argument before a required one, which oclif
# rejects (see issue #53, fixed in PR #52).

if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  echo "This script must be sourced, not executed:  source scripts/test-setup.sh" >&2
  exit 1
fi

_moth_repo="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/.." && pwd)"

printf '\n  moth — manual test setup\n  %s\n\n' "$_moth_repo"

# ---------------------------------------------------------------- proving mode
printf '  Proving mode\n'
printf '    1) wasm    — local, no server. Fine for transfers; NOT enough for contract calls.\n'
printf '    2) server  — a proof server URL. Required for deploy/call/mint.\n'
printf '  Choose [1/2] (default 1): '
read -r _moth_mode

case "$_moth_mode" in
  2)
    printf '  Proof server URL (default http://localhost:6300): '
    read -r _moth_url
    _moth_url="${_moth_url:-http://localhost:6300}"

    printf '  Checking %s ... ' "$_moth_url"
    if curl -s -m 5 -o /dev/null "$_moth_url" 2>/dev/null; then
      printf 'reachable\n'
    else
      printf 'NO RESPONSE\n'
      printf '    Contract operations will fail until it is up. Continuing anyway —\n'
      printf '    a proof server is often started separately or in Docker.\n'
    fi

    export MOTH_PROVER=server
    export MOTH_PROOF_SERVER_URL="$_moth_url"
    ;;
  *)
    export MOTH_PROVER=wasm
    unset MOTH_PROOF_SERVER_URL
    printf '  Using local WASM proving. Contract calls (deploy/call/mint) will need a\n'
    printf '  server — re-source this and choose 2 when you get to section F.\n'
    ;;
esac

# --------------------------------------------------------------------- network
printf '\n  Network [preprod/preview/qanet/devnet/undeployed] (default preprod): '
read -r _moth_net
export MOTH_NETWORK="${_moth_net:-preprod}"

# ------------------------------------------------------------------ isolation
printf '\n  Isolate state in a throwaway HOME? Nothing will touch your real ~/.moth.\n'
printf '  Recommended for every section except the read-only one. [Y/n]: '
read -r _moth_iso
case "$_moth_iso" in
  [Nn]*)
    printf '  Using your real HOME (%s). Wallets you create here are permanent.\n' "$HOME"
    ;;
  *)
    export HOME="$(mktemp -d)"
    printf '  HOME=%s\n' "$HOME"
    ;;
esac

# ---------------------------------------------------------------------- alias
alias moth="node $_moth_repo/packages/cli/bin/moth"

# -------------------------------------------------------------------- summary
printf '\n  Ready.\n'
printf '    moth              node %s/packages/cli/bin/moth\n' "$_moth_repo"
printf '    MOTH_PROVER       %s\n' "$MOTH_PROVER"
printf '    proof server      %s\n' "${MOTH_PROOF_SERVER_URL:-(none — wasm)}"
printf '    network           %s   (pass --network explicitly; this is a reminder, not a default)\n' "$MOTH_NETWORK"
printf '    HOME              %s\n\n' "$HOME"
printf '  These live in THIS shell only. A new terminal needs this sourced again —\n'
printf '  and a new throwaway HOME will not contain wallets made in the old one.\n\n'
printf '  Next:  moth info --network %s\n\n' "$MOTH_NETWORK"

unset _moth_mode _moth_url _moth_net _moth_iso
