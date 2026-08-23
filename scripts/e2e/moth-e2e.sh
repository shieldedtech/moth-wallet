#!/usr/bin/env bash
#
# moth-e2e.sh — drive a real moth wallet end to end against a live testnet.
#
# Given the seed phrase of a wallet that already holds NIGHT (designated for
# DUST generation) and, optionally, shielded and other tokens, this creates a
# throwaway wallet, funds it, registers it for DUST, sends funds back, and
# optionally returns everything at the end. Every command, its exit code, and
# its raw output are saved under a per-run folder, along with the throwaway
# wallet's seed phrase and passphrase.
#
# Runs the same suite two ways:
#   --mode cli      in-process commands (moth transfer, moth dust register, …)
#   --mode daemon   the same operations through `moth daemon serve` + RPC verbs
#   --mode both     one after the other, in separate run folders
#
# This script SPENDS REAL TESTNET FUNDS and refuses to run against mainnet.
#
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SELF_DIR/../.." && pwd)"

# ─── defaults ────────────────────────────────────────────────────────────────
CONFIG=""
MODE="cli"
RETURN_FUNDS=0
KEEP_WALLET=0
RUNS_DIR="$SELF_DIR/runs"
NO_ISOLATE=0
VERBOSE=1
MOTH_BIN="${MOTH_BIN:-$REPO_DIR/packages/cli/bin/moth}"

usage() {
  cat <<USAGE
usage: moth-e2e.sh --config <file> [options]

  --config <file>     Run configuration (see e2e.config.example.json). Required.
  --mode <m>          cli | daemon | both            (default: cli)
  --return-funds      Sweep the throwaway wallet back to the funding wallet
                      and deregister its DUST before finishing.
  --keep-wallet       Do not 'wallet remove' the throwaway wallet at the end.
  --runs-dir <dir>    Where run folders are created  (default: scripts/e2e/runs)
  --no-isolate        Use your real \$HOME instead of a per-run one. The
                      throwaway wallet then lands in ~/.moth alongside your
                      own wallets. Off by default.
  --quiet             Drop --verbose from the moth commands. On by default,
                      because the sync and pre-seed decisions are logged at
                      verbose level and nothing else reports them.
  -h, --help          This text.

Environment:
  MOTH_BIN            Path to the moth entrypoint
                      (default: <repo>/packages/cli/bin/moth)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config)      CONFIG="${2:?--config needs a path}"; shift 2 ;;
    --mode)        MODE="${2:?--mode needs a value}"; shift 2 ;;
    --return-funds) RETURN_FUNDS=1; shift ;;
    --keep-wallet) KEEP_WALLET=1; shift ;;
    --runs-dir)    RUNS_DIR="${2:?--runs-dir needs a path}"; shift 2 ;;
    --no-isolate)  NO_ISOLATE=1; shift ;;
    --quiet)       VERBOSE=0; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) printf 'unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { printf 'moth-e2e: %s\n' "$*" >&2; exit 2; }

[ -n "$CONFIG" ] || { usage >&2; die "--config is required"; }
[ -f "$CONFIG" ] || die "config not found: $CONFIG"
command -v jq   >/dev/null 2>&1 || die "jq is required"
command -v node >/dev/null 2>&1 || die "node is required"
[ -f "$MOTH_BIN" ] || die "moth entrypoint not found at $MOTH_BIN (build first, or set MOTH_BIN)"

# ─── --mode both: re-exec once per mode so each gets its own run folder ──────
if [ "$MODE" = "both" ]; then
  rc=0
  for m in cli daemon; do
    printf '\n═══ mode: %s ═══\n\n' "$m"
    "$0" --config "$CONFIG" --mode "$m" --runs-dir "$RUNS_DIR" \
      $([ "$RETURN_FUNDS" -eq 1 ] && echo --return-funds) \
      $([ "$KEEP_WALLET" -eq 1 ] && echo --keep-wallet) \
      $([ "$NO_ISOLATE" -eq 1 ] && echo --no-isolate) \
      $([ "$VERBOSE" -eq 0 ] && echo --quiet) || rc=1
  done
  exit "$rc"
fi
case "$MODE" in cli|daemon) ;; *) die "--mode must be cli, daemon or both" ;; esac

# ─── read config ─────────────────────────────────────────────────────────────
cfg() { jq -r "$1 // empty" "$CONFIG"; }

NETWORK="$(cfg .network)"
FUND_MNEMONIC="$(cfg .funding.mnemonic)"
FUND_PASS="$(cfg .funding.passphrase)"
FUND_BIRTHDAY="$(cfg .funding.birthdayHeight)"
AMT_UNSHIELDED="$(cfg .amounts.fundUnshieldedNight)"
AMT_SHIELDED="$(cfg .amounts.fundShieldedNight)"
AMT_RETURN="$(cfg .amounts.returnNight)"
AMT_BATCH="$(cfg .amounts.batchNight)"
TOKEN_ID="$(cfg .token.id)"
TOKEN_AMOUNT="$(cfg .token.amount)"
PROVER="$(cfg .prover)"
PROOF_SERVER="$(cfg .proofServerUrl)"
INDEXER_URL="$(cfg .indexerUrl)"
NODE_URL="$(cfg .nodeUrl)"
T_SYNC="$(cfg .timeouts.syncSeconds)";   T_SYNC="${T_SYNC:-900}"
T_DUST="$(cfg .timeouts.dustSeconds)";   T_DUST="${T_DUST:-2400}"
T_POLL="$(cfg .timeouts.pollSeconds)";   T_POLL="${T_POLL:-30}"

: "${AMT_UNSHIELDED:=10}"
: "${AMT_SHIELDED:=0}"
: "${AMT_RETURN:=1}"
: "${AMT_BATCH:=0}"
: "${PROVER:=wasm}"

# ─── preflight: refuse anything that looks like mainnet ──────────────────────
[ -n "$NETWORK" ] || die "config.network is required"
case "$(printf '%s' "$NETWORK" | tr '[:upper:]' '[:lower:]')" in
  *main*) die "refusing to run against \"$NETWORK\" — this script spends funds" ;;
esac
case "$NETWORK" in
  preprod|preview|qanet|devnet) ;;
  *) printf 'moth-e2e: warning: unrecognised network "%s" — continuing\n' "$NETWORK" >&2 ;;
esac

[ -n "$FUND_MNEMONIC" ] || die "config.funding.mnemonic is required"
[ -n "$FUND_PASS" ]     || die "config.funding.passphrase is required"

words=$(printf '%s' "$FUND_MNEMONIC" | wc -w | tr -d ' ')
case "$words" in
  12|15|18|21|24) ;;
  *) die "funding.mnemonic has $words words — expected 12, 15, 18, 21 or 24" ;;
esac

# The config holds a live seed phrase. Refuse to read it if anyone else can.
mode_bits="$(node -e 'const fs=require("fs");process.stdout.write((fs.statSync(process.argv[1]).mode & 0o777).toString(8))' "$CONFIG")"
case "$mode_bits" in
  600|400) ;;
  *) die "config $CONFIG is mode $mode_bits — it holds a seed phrase. chmod 600 it first." ;;
esac

# Same rule the CLI now enforces (#63): plain decimal, at most 6 places. Checked
# up front so a bad amount fails in the first second, not ten minutes in.
check_night() {
  case "$2" in
    ''|0) return 0 ;;  # unset / disabled leg
  esac
  printf '%s' "$2" | grep -Eq '^[0-9]+(\.[0-9]{1,6})?$' \
    || die "$1 = \"$2\" is not a plain NIGHT decimal with at most 6 places"
}
check_night amounts.fundUnshieldedNight "$AMT_UNSHIELDED"
check_night amounts.fundShieldedNight   "$AMT_SHIELDED"
check_night amounts.returnNight         "$AMT_RETURN"
check_night amounts.batchNight          "$AMT_BATCH"

if [ -n "$TOKEN_ID" ]; then
  printf '%s' "$TOKEN_ID" | grep -Eq '^[0-9a-fA-F]{64}$' || die "token.id must be 64 hex chars"
  printf '%s' "$TOKEN_AMOUNT" | grep -Eq '^[0-9]+$' || die "token.amount must be raw base units (digits only)"
fi

night_to_stars() {
  node -e 'const [i,f=""]=process.argv[1].split(".");process.stdout.write((BigInt(i)*1000000n+BigInt((f+"000000").slice(0,6))).toString())' "$1"
}
# Compare two decimal strings of arbitrary size: prints -1, 0 or 1.
bigcmp() {
  node -e 'const a=BigInt(process.argv[1]),b=BigInt(process.argv[2]);process.stdout.write(a<b?"-1":a>b?"1":"0")' "$1" "$2"
}

# ─── run folder ──────────────────────────────────────────────────────────────
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN="$RUNS_DIR/$STAMP-$NETWORK-$MODE"
mkdir -p "$RUN/artifacts" || die "cannot create $RUN"
chmod 700 "$RUN"
touch "$RUN/run.log" "$RUN/steps.ndjson"

if [ "$NO_ISOLATE" -eq 0 ]; then
  # Everything moth writes keys off homedir() and there is no override, so an
  # isolated run means an isolated HOME: keystores, sync store, api-keys and
  # the daemon audit log all land inside the run folder. It is a real directory
  # under --runs-dir, not a mktemp that gets swept away with the wallets in it.
  export HOME="$RUN/home"
  mkdir -p "$HOME"
fi

log() { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$RUN/run.log"; }
note() { printf '%s\n' "$*" >>"$RUN/run.log"; }

FUND_WALLET="funding"
TEMP_WALLET="e2e-$STAMP"
TEMP_PASS="$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))')"

# ─── moth wrapper + network flags ────────────────────────────────────────────
NETFLAGS=""
# On by default. The sync narration — including every `Pre-seed:` decision, which
# is the whole reason a first sync is fast or slow — goes through log_verbose, so
# without this the per-step .err files are nearly empty and the one thing worth
# reading is the one thing missing. base-command redacts seeds, mnemonics and
# passphrases from verbose output, and the run folder is 0700 regardless.
[ "$VERBOSE" -eq 1 ]   && NETFLAGS="$NETFLAGS --verbose"
[ -n "$PROVER" ]       && NETFLAGS="$NETFLAGS --prover $PROVER"
[ -n "$PROOF_SERVER" ] && NETFLAGS="$NETFLAGS --proof-server $PROOF_SERVER"
[ -n "$INDEXER_URL" ]  && NETFLAGS="$NETFLAGS --indexer $INDEXER_URL"
[ -n "$NODE_URL" ]     && NETFLAGS="$NETFLAGS --node-url $NODE_URL"
# shellcheck disable=SC2086
moth() { node "$MOTH_BIN" "$@" --network "$NETWORK" $NETFLAGS; }
moth_bare() { node "$MOTH_BIN" "$@"; }

STEP=0
FAILED=0
# Newline-separated: assert labels are sentences, and a space-joined list broke
# them into one bullet per word in summary.md.
NL='
'
FAIL_NAMES=""
CURRENT_PASS_OWNER="(none)"

# use_pass <wallet> <passphrase> — every moth call reads MOTH_PASSPHRASE, and
# the two wallets have different ones, so this is switched explicitly and the
# switch is logged (the value never is).
use_pass() {
  export MOTH_PASSPHRASE="$2"
  CURRENT_PASS_OWNER="$1"
  note "  (passphrase now: $1)"
}

record() { # record <name> <rc> <secs> <out> <err> <critical>
  jq -nc --arg name "$1" --arg rc "$2" --arg secs "$3" --arg out "$4" \
        --arg err "$5" --arg critical "$6" --arg mode "$MODE" \
        '{step:$name, exit:($rc|tonumber), seconds:($secs|tonumber),
          stdout:$out, stderr:$err, critical:($critical=="1"), mode:$mode}' \
    >>"$RUN/steps.ndjson"
}

# run_step <name> <critical 0|1> -- <cmd…>
run_step() {
  local name="$1" critical="$2"; shift 2
  [ "$1" = "--" ] && shift
  STEP=$((STEP + 1))
  local tag out err t0 rc dt
  tag="$(printf '%02d-%s' "$STEP" "$name")"
  out="$RUN/artifacts/$tag.out"; err="$RUN/artifacts/$tag.err"
  log "▶ $name"
  note "  \$ $* (as $CURRENT_PASS_OWNER)"
  t0=$SECONDS
  # STDIN_TEXT feeds a secret on stdin without a pipe: piping into this function
  # would put it in a subshell and every counter it increments would be lost.
  # A here-string keeps it out of the process list, unlike `printf | cmd`.
  if [ -n "${STDIN_TEXT:-}" ]; then
    "$@" >"$out" 2>"$err" <<<"$STDIN_TEXT"; rc=$?
    STDIN_TEXT=""
  else
    "$@" >"$out" 2>"$err"; rc=$?
  fi
  dt=$((SECONDS - t0))
  record "$name" "$rc" "$dt" "$tag.out" "$tag.err" "$critical"
  if [ "$rc" -eq 0 ]; then
    log "  ✓ $name (${dt}s)"
  else
    log "  ✗ $name exit=$rc (${dt}s) — see artifacts/$tag.err"
    tail -3 "$err" | sed 's/^/      /' | tee -a "$RUN/run.log"
    FAILED=$((FAILED + 1)); FAIL_NAMES="$FAIL_NAMES${NL}$name"
    if [ "$critical" = "1" ]; then
      log "  ‼ that step was critical — stopping"
      finish 1
    fi
  fi
  LAST_OUT="$out"; LAST_ERR="$err"; LAST_RC="$rc"
  return "$rc"
}

# Same, but stdout is a secret: it goes to a 600 file and is never echoed.
run_step_private() {
  local name="$1" critical="$2"; shift 2
  [ "$1" = "--" ] && shift
  STEP=$((STEP + 1))
  local tag out err t0 rc dt
  tag="$(printf '%02d-%s' "$STEP" "$name")"
  out="$RUN/artifacts/$tag.out"; err="$RUN/artifacts/$tag.err"
  : >"$out"; chmod 600 "$out"
  log "▶ $name  (output withheld — contains key material)"
  t0=$SECONDS
  "$@" >"$out" 2>"$err"; rc=$?
  dt=$((SECONDS - t0))
  record "$name" "$rc" "$dt" "$tag.out" "$tag.err" "$critical"
  if [ "$rc" -eq 0 ]; then log "  ✓ $name (${dt}s)"; else
    log "  ✗ $name exit=$rc (${dt}s)"
    FAILED=$((FAILED + 1)); FAIL_NAMES="$FAIL_NAMES${NL}$name"
    [ "$critical" = "1" ] && { log "  ‼ critical — stopping"; finish 1; }
  fi
  LAST_OUT="$out"; LAST_RC="$rc"
  return "$rc"
}

# run_step_expect_fail <name> -- <cmd…>
# For steps that MUST refuse. A non-zero exit is the pass condition, so
# run_step's accounting is inverted here rather than paired with an assert.
run_step_expect_fail() {
  local name="$1"; shift
  [ "$1" = "--" ] && shift
  STEP=$((STEP + 1))
  local tag out err t0 rc dt
  tag="$(printf '%02d-%s' "$STEP" "$name")"
  out="$RUN/artifacts/$tag.out"; err="$RUN/artifacts/$tag.err"
  log "▶ $name  (expecting a refusal)"
  note "  \$ $* (as $CURRENT_PASS_OWNER)"
  t0=$SECONDS
  "$@" >"$out" 2>"$err"; rc=$?
  dt=$((SECONDS - t0))
  if [ "$rc" -ne 0 ]; then
    log "  ✓ $name refused as it should (exit $rc, ${dt}s)"
    record "$name" 0 "$dt" "$tag.out" "$tag.err" 0
  else
    log "  ✗ $name SUCCEEDED and should not have — it accepted input it must reject"
    head -3 "$out" | sed 's/^/      /' | tee -a "$RUN/run.log"
    record "$name" 1 "$dt" "$tag.out" "$tag.err" 0
    FAILED=$((FAILED + 1)); FAIL_NAMES="$FAIL_NAMES${NL}$name"
  fi
  LAST_OUT="$out"; LAST_RC="$rc"
  return 0
}

assert() { # assert <label> <condition-desc> <0|1 truth>
  if [ "$3" = "1" ]; then
    log "  ✓ assert: $1"
  else
    log "  ✗ assert: $1 — expected $2"
    FAILED=$((FAILED + 1)); FAIL_NAMES="$FAIL_NAMES${NL}assert:$1"
    record "assert:$1" 1 0 "" "" 0
  fi
}

# ─── daemon lifecycle ────────────────────────────────────────────────────────
DAEMON_PIDS=""
MAX_SPEND=""

start_daemon() { # start_daemon <wallet> <passphrase>
  local w="$1" p="$2" sock pid waited
  sock="$HOME/.moth/sync/$NETWORK/$w.sock"
  rm -f "$sock"
  log "▶ starting daemon for $w (max-spend $MAX_SPEND NIGHT)"
  # shellcheck disable=SC2086
  MOTH_PASSPHRASE="$p" MOTH_DAEMON_AUTO_APPROVE=1 \
    node "$MOTH_BIN" daemon serve --wallet "$w" --network "$NETWORK" \
      --auto-approve --max-spend "$MAX_SPEND" --idle-timeout 0 --wait-for-sync \
      $NETFLAGS >"$RUN/artifacts/daemon-$w.log" 2>&1 &
  pid=$!
  DAEMON_PIDS="$DAEMON_PIDS $pid"
  waited=0
  while [ ! -S "$sock" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      log "  ✗ daemon for $w died before binding — see artifacts/daemon-$w.log"
      tail -5 "$RUN/artifacts/daemon-$w.log" | sed 's/^/      /' | tee -a "$RUN/run.log"
      FAILED=$((FAILED + 1)); FAIL_NAMES="$FAIL_NAMES${NL}daemon-start:$w"
      return 1
    fi
    [ "$waited" -ge "$T_SYNC" ] && { log "  ✗ daemon for $w never bound $sock within ${T_SYNC}s"; return 1; }
    sleep 5; waited=$((waited + 5))
    [ $((waited % 60)) -eq 0 ] && log "  … waiting for daemon $w to sync and bind (${waited}s)"
  done
  log "  ✓ daemon for $w listening (pid $pid, synced) after ${waited}s"
  return 0
}

stop_daemons() {
  [ -n "$DAEMON_PIDS" ] || return 0
  log "stopping daemons:$DAEMON_PIDS"
  for pid in $DAEMON_PIDS; do kill "$pid" 2>/dev/null; done
  sleep 3
  for pid in $DAEMON_PIDS; do kill -9 "$pid" 2>/dev/null; done
  DAEMON_PIDS=""
}

# ─── balance reading (identical shape from both modes) ───────────────────────
read_balance() { # read_balance <wallet> <pass> <tag> → prints path to json
  # Separate statements on purpose: `local a="$1" f="pre-$a"` looks like it works
  # and does not. All arguments to `local` are expanded BEFORE the builtin
  # assigns any of them, so `$a` is still unset — and under `set -u` that aborts
  # the function on its first line. Every balance read returned nothing, which
  # read downstream as "this wallet holds 0 NIGHT".
  local w="$1" p="$2" tag="$3"
  local f="$RUN/artifacts/balance-$tag.json"
  if [ "$MODE" = "daemon" ]; then
    ( cd "$REPO_DIR" && node scripts/e2e/daemon-state.mjs "$NETWORK" "$w" ) >"$f" 2>>"$RUN/run.log"
  else
    # --wait-timeout-ms so this waits for synced=true instead of returning
    # whatever the default 5-minute window saw. A wallet whose birthday predates
    # every reference scans from genesis, which is far longer than that, and an
    # unsynced snapshot reports zero balances rather than an error.
    # shellcheck disable=SC2086
    MOTH_PASSPHRASE="$p" node "$MOTH_BIN" balance --wallet "$w" --network "$NETWORK" \
      --output json --wait-timeout-ms "$((T_SYNC * 1000))" $NETFLAGS >"$f" 2>>"$RUN/run.log"
  fi
  printf '%s' "$f"
}

bal_field() { jq -r "$2" "$1"; }

wait_for_gain() { # wait_for_gain <wallet> <pass> <jq-path> <baseline> <timeout> <label>
  local w="$1" p="$2" path="$3" base="$4" tmo="$5" label="$6"
  local waited=0 f cur
  log "▶ waiting for $label to rise above $base (timeout ${tmo}s)"
  while [ "$waited" -lt "$tmo" ]; do
    sleep "$T_POLL"; waited=$((waited + T_POLL))
    f="$(read_balance "$w" "$p" "wait-$waited")"
    cur="$(bal_field "$f" "$path")"
    [ -z "$cur" ] && cur=0
    if [ "$(bigcmp "$cur" "$base")" = "1" ]; then
      log "  ✓ $label rose to $cur after ${waited}s"
      record "wait:$label" 0 "$waited" "" "" 0
      return 0
    fi
    [ $((waited % 120)) -eq 0 ] && log "  … still $cur after ${waited}s"
  done
  log "  ✗ $label never rose above $base within ${tmo}s"
  FAILED=$((FAILED + 1)); FAIL_NAMES="$FAIL_NAMES${NL}wait:$label"
  record "wait:$label" 1 "$waited" "" "" 0
  return 1
}

# ─── transfer + dust, one call shape per mode ───────────────────────────────
xfer_night() { # xfer_night <name> <wallet> <pass> <night-decimal> <to> <shielded 0|1>
  local name="$1" w="$2" p="$3" amt="$4" to="$5" sh="$6"
  use_pass "$w" "$p"
  if [ "$MODE" = "daemon" ]; then
    run_step "$name" 0 -- moth daemon transfer --wallet "$w" --to "$to" \
      --night "$amt" --type "$([ "$sh" = "1" ] && echo shielded || echo unshielded)" --output json
  else
    if [ "$sh" = "1" ]; then
      run_step "$name" 0 -- moth transfer "$amt" --wallet "$w" --to "$to" --shielded --yes --output json
    else
      run_step "$name" 0 -- moth transfer "$amt" --wallet "$w" --to "$to" --yes --output json
    fi
  fi
}

xfer_raw() { # xfer_raw <name> <wallet> <pass> <raw-units> <token-id> <to> <shielded 0|1>
  local name="$1" w="$2" p="$3" raw="$4" tok="$5" to="$6" sh="$7"
  use_pass "$w" "$p"
  if [ "$MODE" = "daemon" ]; then
    run_step "$name" 0 -- moth daemon transfer --wallet "$w" --to "$to" \
      --amount "$raw" --token-id "$tok" --type "$([ "$sh" = "1" ] && echo shielded || echo unshielded)" --output json
  else
    if [ "$sh" = "1" ]; then
      run_step "$name" 0 -- moth transfer --wallet "$w" --to "$to" --amount "$raw" \
        --token-id "$tok" --shielded --yes --output json
    else
      run_step "$name" 0 -- moth transfer --wallet "$w" --to "$to" --amount "$raw" \
        --token-id "$tok" --yes --output json
    fi
  fi
}

tx_id_from() { jq -r '.txHash // .txId // empty' "$1"; }

# ─── summary + teardown ─────────────────────────────────────────────────────
finish() {
  local rc="${1:-0}"
  stop_daemons
  {
    printf '# moth e2e run — %s\n\n' "$STAMP"
    printf '| field | value |\n|---|---|\n'
    printf '| network | %s |\n' "$NETWORK"
    printf '| mode | %s |\n' "$MODE"
    printf '| funding wallet | %s |\n' "$FUND_WALLET"
    printf '| throwaway wallet | %s |\n' "$TEMP_WALLET"
    printf '| return funds | %s |\n' "$([ "$RETURN_FUNDS" -eq 1 ] && echo yes || echo no)"
    printf '| isolated HOME | %s |\n' "$([ "$NO_ISOLATE" -eq 0 ] && echo "$RUN/home" || echo 'no — real $HOME')"
    printf '| verbose | %s |\n' "$([ "$VERBOSE" -eq 1 ] && echo yes || echo 'no (--quiet)')"
    printf '| steps run | %s |\n' "$STEP"
    printf '| failures | %s |\n' "$FAILED"
    printf '| moth | %s |\n' "$MOTH_BIN"
    printf '| commit | %s |\n\n' "$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    if [ "$FAILED" -gt 0 ]; then
      printf '## failures\n\n'
      printf '%s\n' "$FAIL_NAMES" | while IFS= read -r n; do
        [ -n "$n" ] && printf -- '- %s\n' "$n"
      done
      printf '\n'
    fi
    printf '## steps\n\n| # | step | exit | secs |\n|---|---|---|---|\n'
    nl -ba "$RUN/steps.ndjson" 2>/dev/null | while read -r i line; do
      printf '| %s | %s | %s | %s |\n' "$i" \
        "$(printf '%s' "$line" | jq -r .step)" \
        "$(printf '%s' "$line" | jq -r .exit)" \
        "$(printf '%s' "$line" | jq -r .seconds)"
    done
    printf '\nRaw output for every step is in `artifacts/`.\n'
    printf 'The throwaway wallet seed and passphrase are in `wallet-secrets.json` (mode 600).\n'
  } >"$RUN/summary.md"
  log ""
  log "run folder: $RUN"
  log "summary:    $RUN/summary.md"
  if [ "$FAILED" -gt 0 ]; then
    log "FAILURES ($FAILED):"
    printf '%s\n' "$FAIL_NAMES" | while IFS= read -r n; do
      [ -n "$n" ] && log "  - $n"
    done
    exit 1
  fi
  log "all steps passed"
  exit "$rc"
}
trap 'stop_daemons' EXIT
trap 'log "interrupted"; finish 130' INT TERM

# ═════════════════════════════════════════════════════════════════════════════
log "moth-e2e — network=$NETWORK mode=$MODE run=$RUN"
log "moth=$MOTH_BIN commit=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
[ "$NO_ISOLATE" -eq 0 ] && log "isolated HOME=$HOME"

# ─── phase 0: preflight ─────────────────────────────────────────────────────
run_step version   0 -- moth_bare --version
run_step chain-info 1 -- moth info

# An isolated HOME starts with no pre-seed reference, so every wallet in it
# would sync from its birthday with nothing to start from. Installing the
# repository's packaged reference first is what the pre-seed path is for — and
# it exercises `preseed install`. Note the gate is `reference height <=
# birthday`: the throwaway wallet is born now and benefits, while a funded
# wallet older than the packaged reference will still walk the chain.
if [ "$NO_ISOLATE" -eq 0 ]; then
  run_step preseed-install 0 -- moth preseed install
fi

# ─── phase 1: the funding wallet ────────────────────────────────────────────
BIRTHDAY_FLAGS="--birthday-discover"
[ -n "$FUND_BIRTHDAY" ] && BIRTHDAY_FLAGS="--birthday-height $FUND_BIRTHDAY"
log "▶ importing funding wallet (birthday: $BIRTHDAY_FLAGS)"
use_pass "$FUND_WALLET" "$FUND_PASS"
# `wallet import` reads the phrase from stdin — never a flag or an env var.
STDIN_TEXT="$FUND_MNEMONIC"
# shellcheck disable=SC2086
run_step import-funding 1 -- \
  moth wallet import --name "$FUND_WALLET" $BIRTHDAY_FLAGS --output json

run_step wallet-list       0 -- moth wallet list --output json
run_step preseed-status    0 -- moth preseed status
run_step funding-addresses 1 -- moth wallet address --wallet "$FUND_WALLET" --output json
FUND_ADDR_NIGHT="$(jq -r ".addresses.nightExternal.bech32m.$NETWORK" "$LAST_OUT")"
FUND_ADDR_ZSWAP="$(jq -r ".addresses.zswap.bech32m.$NETWORK" "$LAST_OUT")"
[ -n "$FUND_ADDR_NIGHT" ] && [ "$FUND_ADDR_NIGHT" != "null" ] \
  || die "could not read the funding wallet's $NETWORK NIGHT address"
log "  funding NIGHT address: $FUND_ADDR_NIGHT"

# The daemon has to be up before any balance read in daemon mode.
if [ "$MODE" = "daemon" ]; then
  # Cap above the largest leg so the harness's own transfers are not refused,
  # but still a real cap — it is what bounds an auto-approving daemon.
  MAX_SPEND="$(node -e '
    const a=process.argv.slice(2).filter(Boolean).map(Number);
    process.stdout.write(String(Math.max(...a, 1) * 2));' \
    "$AMT_UNSHIELDED" "$AMT_SHIELDED" "$AMT_RETURN")"
  run_step daemon-key-gen  0 -- moth daemon key gen --label "e2e-$STAMP" --output json
  run_step daemon-key-list 0 -- moth daemon key list --output json
  start_daemon "$FUND_WALLET" "$FUND_PASS" || finish 1
  # `wallet status` asks a daemon hosting this wallet, so it belongs here rather
  # than with the offline inspection steps — in cli mode nothing is hosting
  # anything and it fails with "No TUI is hosting wallet ...".
  run_step funding-status 0 -- moth wallet status --wallet "$FUND_WALLET"
fi

BAL_FUND_BEFORE="$(read_balance "$FUND_WALLET" "$FUND_PASS" "funding-before")"
cp "$BAL_FUND_BEFORE" "$RUN/balances-funding-before.json"
FUND_NIGHT_0="$(bal_field "$BAL_FUND_BEFORE" '.balances.night.unshielded')"
FUND_SH_0="$(bal_field "$BAL_FUND_BEFORE" '.balances.night.shielded')"
FUND_DUST_0="$(bal_field "$BAL_FUND_BEFORE" '.balances.dust')"

# No numbers at all means the read failed, which is a different fault from a
# wallet that is genuinely empty — and reporting it as "holds 0" sent the last
# run chasing the wrong thing.
if [ -z "$FUND_NIGHT_0" ] || [ "$FUND_NIGHT_0" = "null" ]; then
  log "  ✗ could not read the funding wallet's balance — see $BAL_FUND_BEFORE and run.log"
  FAILED=$((FAILED + 1)); FAIL_NAMES="$FAIL_NAMES${NL}read-funding-balance"
  finish 1
fi
if [ "$(bal_field "$BAL_FUND_BEFORE" '.synced')" != "true" ]; then
  log "  ! funding wallet is NOT synced after ${T_SYNC}s — balances below are a partial snapshot."
  log "    A wallet whose birthday predates every stored reference scans from genesis;"
  log "    raise timeouts.syncSeconds, or check 'Pre-seed' lines in ~/.moth/moth.log."
fi
log "  funding: unshielded=$FUND_NIGHT_0 STARS shielded=$FUND_SH_0 dust=$FUND_DUST_0 SPECK"

assert "funding wallet holds unshielded NIGHT" "> 0" \
  "$([ "$(bigcmp "${FUND_NIGHT_0:-0}" 0)" = "1" ] && echo 1 || echo 0)"
assert "funding wallet holds DUST to pay fees" "> 0" \
  "$([ "$(bigcmp "${FUND_DUST_0:-0}" 0)" = "1" ] && echo 1 || echo 0)"

NEED="$(night_to_stars "$AMT_UNSHIELDED")"
if [ "$(bigcmp "${FUND_NIGHT_0:-0}" "$NEED")" = "-1" ]; then
  log "  ✗ funding wallet holds $FUND_NIGHT_0 STARS, less than the $NEED it is asked to send"
  finish 1
fi

use_pass "$FUND_WALLET" "$FUND_PASS"
run_step funding-dust-status 0 -- moth dust status --wallet "$FUND_WALLET" --output json
if [ "$LAST_RC" -eq 0 ]; then
  assert "funding wallet is generating DUST" "generating=true" \
    "$([ "$(jq -r '.generating' "$LAST_OUT")" = "true" ] && echo 1 || echo 0)"
fi

# ─── phase 2: the throwaway wallet ──────────────────────────────────────────
use_pass "$TEMP_WALLET" "$TEMP_PASS"
run_step_private generate-temp 1 -- \
  moth wallet generate --name "$TEMP_WALLET" --show-mnemonic --output json
TEMP_MNEMONIC="$(jq -r '.mnemonic' "$LAST_OUT")"
[ -n "$TEMP_MNEMONIC" ] && [ "$TEMP_MNEMONIC" != "null" ] \
  || die "wallet generate did not return a mnemonic"

jq -n --arg wallet "$TEMP_WALLET" --arg pass "$TEMP_PASS" --arg mn "$TEMP_MNEMONIC" \
      --arg net "$NETWORK" --arg run "$RUN" \
  '{wallet:$wallet, network:$net, passphrase:$pass, mnemonic:$mn, run:$run,
    note:"Throwaway wallet for an e2e run. Anyone holding this phrase controls it."}' \
  >"$RUN/wallet-secrets.json"
chmod 600 "$RUN/wallet-secrets.json"
log "  ✓ throwaway wallet secrets saved to wallet-secrets.json (mode 600)"

run_step temp-addresses 1 -- moth wallet address --wallet "$TEMP_WALLET" --output json
TEMP_ADDR_NIGHT="$(jq -r ".addresses.nightExternal.bech32m.$NETWORK" "$LAST_OUT")"
TEMP_ADDR_ZSWAP="$(jq -r ".addresses.zswap.bech32m.$NETWORK" "$LAST_OUT")"
[ -n "$TEMP_ADDR_NIGHT" ] && [ "$TEMP_ADDR_NIGHT" != "null" ] \
  || die "could not read the throwaway wallet's $NETWORK NIGHT address"
log "  throwaway NIGHT address: $TEMP_ADDR_NIGHT"

# export-phrase must return exactly what generate printed (#59).
run_step_private export-phrase 0 -- moth wallet export-phrase --wallet "$TEMP_WALLET" --yes --output json
if [ "$LAST_RC" -eq 0 ]; then
  assert "export-phrase round-trips the generated phrase" "identical 24 words" \
    "$([ "$(jq -r '.mnemonic' "$LAST_OUT")" = "$TEMP_MNEMONIC" ] && echo 1 || echo 0)"
fi
run_step_private export-seed-hex 0 -- moth wallet export-phrase --wallet "$TEMP_WALLET" --seed-hex --yes --output json

# `wallet use` then a bare `wallet address` — the active-wallet path (#60).
run_step wallet-use-temp 0 -- moth wallet use "$TEMP_WALLET"
run_step address-active  0 -- moth wallet address --output json
if [ "$LAST_RC" -eq 0 ]; then
  assert "bare 'wallet address' resolves the active wallet" "name=$TEMP_WALLET" \
    "$([ "$(jq -r '.name' "$LAST_OUT")" = "$TEMP_WALLET" ] && echo 1 || echo 0)"
fi

# An unfunded wallet must not report itself registered (#58).
run_step_expect_fail dust-register-empty -- moth dust register --wallet "$TEMP_WALLET" --yes

# ─── phase 3: fund the throwaway wallet ─────────────────────────────────────
xfer_night fund-unshielded "$FUND_WALLET" "$FUND_PASS" "$AMT_UNSHIELDED" "$TEMP_ADDR_NIGHT" 0
[ "$LAST_RC" -eq 0 ] && log "  tx: $(tx_id_from "$LAST_OUT")"

if [ "$MODE" = "daemon" ]; then
  start_daemon "$TEMP_WALLET" "$TEMP_PASS" || finish 1
fi
wait_for_gain "$TEMP_WALLET" "$TEMP_PASS" '.balances.night.unshielded' 0 "$T_SYNC" \
  "throwaway unshielded NIGHT"

if [ "$AMT_SHIELDED" != "0" ] && [ -n "$AMT_SHIELDED" ]; then
  if [ -n "$TEMP_ADDR_ZSWAP" ] && [ "$TEMP_ADDR_ZSWAP" != "null" ]; then
    xfer_night fund-shielded "$FUND_WALLET" "$FUND_PASS" "$AMT_SHIELDED" "$TEMP_ADDR_ZSWAP" 1
    [ "$LAST_RC" -eq 0 ] && wait_for_gain "$TEMP_WALLET" "$TEMP_PASS" \
      '.balances.night.shielded' 0 "$T_SYNC" "throwaway shielded NIGHT"
  else
    log "  — skipping shielded leg: no zswap address for $NETWORK"
  fi
fi

if [ -n "$TOKEN_ID" ]; then
  xfer_raw fund-token "$FUND_WALLET" "$FUND_PASS" "$TOKEN_AMOUNT" "$TOKEN_ID" "$TEMP_ADDR_NIGHT" 0
  # The positional form must be REFUSED for a non-NIGHT token (#62).
  if [ "$MODE" = "cli" ]; then
    use_pass "$FUND_WALLET" "$FUND_PASS"
    run_step_expect_fail token-positional-refused -- moth transfer 1 \
      --wallet "$FUND_WALLET" --to "$TEMP_ADDR_NIGHT" --token-id "$TOKEN_ID" --yes --output json
  fi
fi

# ─── phase 4: DUST on the throwaway wallet ──────────────────────────────────
use_pass "$TEMP_WALLET" "$TEMP_PASS"
run_step temp-dust-before 0 -- moth dust status --wallet "$TEMP_WALLET" --output json

if [ "$MODE" = "daemon" ]; then
  run_step dust-register 0 -- moth daemon dust register --wallet "$TEMP_WALLET" \
    --timeout-ms "$((T_DUST * 1000))" --output json
else
  # --wait blocks until the NIGHT that just arrived has generated enough DUST to
  # pay for its own designation; without it this returns status=not_yet.
  run_step dust-register 0 -- moth dust register --wallet "$TEMP_WALLET" --yes \
    --wait --wait-timeout "$T_DUST" --output json
fi
if [ "$LAST_RC" -eq 0 ] && [ "$MODE" = "cli" ]; then
  assert "dust register completed rather than deferring" "status=registered" \
    "$([ "$(jq -r '.status' "$LAST_OUT")" = "registered" ] && echo 1 || echo 0)"
fi

wait_for_gain "$TEMP_WALLET" "$TEMP_PASS" '.balances.dust' 0 "$T_DUST" "throwaway DUST"
use_pass "$TEMP_WALLET" "$TEMP_PASS"
run_step temp-dust-after 0 -- moth dust status --wallet "$TEMP_WALLET" --output json
if [ "$LAST_RC" -eq 0 ]; then
  assert "throwaway wallet is generating DUST" "generating=true" \
    "$([ "$(jq -r '.generating' "$LAST_OUT")" = "true" ] && echo 1 || echo 0)"
fi

# ─── phase 5: spend from the throwaway wallet ───────────────────────────────
# This is the real test of the round trip: the throwaway wallet now has to pay
# its own fee out of DUST it generated itself.
B="$(read_balance "$FUND_WALLET" "$FUND_PASS" "funding-mid")"
FUND_NIGHT_MID="$(bal_field "$B" '.balances.night.unshielded')"

xfer_night return-some "$TEMP_WALLET" "$TEMP_PASS" "$AMT_RETURN" "$FUND_ADDR_NIGHT" 0
if [ "$LAST_RC" -eq 0 ]; then
  log "  tx: $(tx_id_from "$LAST_OUT")"
  wait_for_gain "$FUND_WALLET" "$FUND_PASS" '.balances.night.unshielded' \
    "$FUND_NIGHT_MID" "$T_SYNC" "funding unshielded NIGHT (return leg)"
fi

if [ "$AMT_BATCH" != "0" ] && [ -n "$AMT_BATCH" ] && [ "$MODE" = "cli" ]; then
  jq -n --arg to "$FUND_ADDR_NIGHT" --arg amt "$AMT_BATCH" \
    '[{to:$to, amount:$amt}, {to:$to, amount:$amt}]' >"$RUN/batch.json"
  use_pass "$TEMP_WALLET" "$TEMP_PASS"
  run_step batch-transfer 0 -- moth transfer batch "$RUN/batch.json" \
    --wallet "$TEMP_WALLET" --yes --output json

  # The batch path still parses amounts with parseFloat (core/src/wallet/
  # batch-transfer.ts:68), so "1,5" is read as 1 NIGHT and "0.0000001" rounds
  # to a zero-value transfer. `moth transfer` refuses both. This step asserts
  # the refusal the single-transfer path gives; it FAILS today, on purpose.
  # "1,5" is a normal decimal across most of Europe. The single-transfer path
  # refuses it; the batch path reads it as 1 NIGHT. Sent to the FUNDING address
  # so that if the bug lets it through, the NIGHT lands back where it came from.
  # Skipped below 1 NIGHT, where an insufficient-funds failure would look like a
  # refusal and prove nothing.
  PROBE_BAL="$(read_balance "$TEMP_WALLET" "$TEMP_PASS" "temp-probe")"
  if [ "$(bigcmp "$(bal_field "$PROBE_BAL" '.balances.night.unshielded')" 1000000)" != "-1" ]; then
    jq -n --arg to "$FUND_ADDR_NIGHT" '[{to:$to, amount:"1,5"}]' >"$RUN/batch-bad.json"
    run_step_expect_fail batch-malformed-amount -- moth transfer batch "$RUN/batch-bad.json" \
      --wallet "$TEMP_WALLET" --yes --output json
  else
    log "  — skipping the malformed-amount probe: throwaway wallet holds under 1 NIGHT"
  fi
elif [ "$AMT_BATCH" != "0" ] && [ -n "$AMT_BATCH" ]; then
  log "  — skipping batch: no daemon verb for it, the daemon takes one transfer per call"
fi

# ─── phase 6: optional return of everything ─────────────────────────────────
if [ "$RETURN_FUNDS" -eq 1 ]; then
  log "▶ returning all funds to the funding wallet"
  SWEEP="$(read_balance "$TEMP_WALLET" "$TEMP_PASS" "temp-sweep")"
  SW_UN="$(bal_field "$SWEEP" '.balances.night.unshielded')"
  SW_SH="$(bal_field "$SWEEP" '.balances.night.shielded')"
  NIGHT_ID="$(printf '0%.0s' $(seq 1 64))"

  if [ "$(bigcmp "${SW_UN:-0}" 0)" = "1" ]; then
    xfer_raw sweep-unshielded "$TEMP_WALLET" "$TEMP_PASS" "$SW_UN" "$NIGHT_ID" "$FUND_ADDR_NIGHT" 0
    if [ "$LAST_RC" -ne 0 ]; then
      # A full sweep can fail where a slightly smaller one succeeds; try 95%
      # rather than leaving the balance stranded, and say so.
      RETRY="$(node -e 'process.stdout.write((BigInt(process.argv[1])*95n/100n).toString())' "$SW_UN")"
      log "  full unshielded sweep failed — retrying with 95% ($RETRY STARS)"
      xfer_raw sweep-unshielded-95 "$TEMP_WALLET" "$TEMP_PASS" "$RETRY" "$NIGHT_ID" "$FUND_ADDR_NIGHT" 0
    fi
  fi
  if [ "$(bigcmp "${SW_SH:-0}" 0)" = "1" ] && [ -n "$FUND_ADDR_ZSWAP" ] && [ "$FUND_ADDR_ZSWAP" != "null" ]; then
    xfer_raw sweep-shielded "$TEMP_WALLET" "$TEMP_PASS" "$SW_SH" "$NIGHT_ID" "$FUND_ADDR_ZSWAP" 1
  fi

  if [ -n "$TOKEN_ID" ]; then
    TOK_BAL="$(jq -r --arg t "$TOKEN_ID" \
      '[.balances.otherTokens[] | select(.tokenId==$t) | .amount] | add // "0"' "$SWEEP")"
    if [ "$(bigcmp "${TOK_BAL:-0}" 0)" = "1" ]; then
      xfer_raw sweep-token "$TEMP_WALLET" "$TEMP_PASS" "$TOK_BAL" "$TOKEN_ID" "$FUND_ADDR_NIGHT" 0
    fi
  fi

  use_pass "$TEMP_WALLET" "$TEMP_PASS"
  if [ "$MODE" = "daemon" ]; then
    run_step dust-deregister 0 -- moth daemon dust deregister --wallet "$TEMP_WALLET" --output json
  else
    run_step dust-deregister 0 -- moth dust deregister --wallet "$TEMP_WALLET" --yes --output json
  fi
  log "  note: DUST itself is not transferable — any left in the throwaway wallet is abandoned"
fi

# ─── phase 7: teardown ─────────────────────────────────────────────────────
stop_daemons

BAL_TEMP_END="$(read_balance "$TEMP_WALLET" "$TEMP_PASS" "temp-final")"
cp "$BAL_TEMP_END" "$RUN/balances-throwaway-after.json" 2>/dev/null
BAL_FUND_END="$(read_balance "$FUND_WALLET" "$FUND_PASS" "funding-after")"
cp "$BAL_FUND_END" "$RUN/balances-funding-after.json" 2>/dev/null

if [ "$KEEP_WALLET" -eq 0 ]; then
  use_pass "$TEMP_WALLET" "$TEMP_PASS"
  run_step remove-temp 0 -- moth wallet remove "$TEMP_WALLET" --yes
  run_step wallet-list-final 0 -- moth wallet list --output json
  if [ "$LAST_RC" -eq 0 ]; then
    assert "throwaway wallet is gone from the list" "absent" \
      "$([ "$(jq -r --arg n "$TEMP_WALLET" '[.[] | select(.name==$n)] | length' "$LAST_OUT" 2>/dev/null)" = "0" ] && echo 1 || echo 0)"
  fi
else
  log "  — keeping wallet $TEMP_WALLET (--keep-wallet); its phrase is in wallet-secrets.json"
fi

finish 0
