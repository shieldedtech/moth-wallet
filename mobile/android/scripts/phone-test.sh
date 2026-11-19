#!/usr/bin/env bash
# Installs the debug APK on the connected phone and drives the spike over adb:
# launch, wait for the engine, then run each action in turn, following the app's log.
#   scripts/phone-test.sh                 # install, launch, create, unlock, sync, balances
#   scripts/phone-test.sh unlock sync     # only these actions (wallet already created)
# Output is also written to build/phone-test-<time>.log.
set -euo pipefail
cd "$(dirname "$0")/.."
APK=app/build/outputs/apk/debug/app-debug.apk
PKG=io.shielded.moth
ACTIVITY=$PKG/.MainActivity
ACTIONS=("$@")
[ ${#ACTIONS[@]} -gt 0 ] || ACTIONS=(create unlock sync balances)
LOG=build/phone-test-$(date +%Y%m%d-%H%M%S).log
mkdir -p build

adb get-state >/dev/null || { echo "error: no phone on adb" >&2; exit 1; }
adb install -r "$APK" | tail -1
adb logcat -c
adb logcat -v time -s MothSpike:I MothEngine:I AndroidRuntime:E chromium:E >"$LOG" &
LOGCAT=$!
trap 'kill $LOGCAT 2>/dev/null || true' EXIT

wait_for() { # pattern, seconds
  local end=$((SECONDS + $2))
  until grep -qE "$1" "$LOG"; do
    [ $SECONDS -lt $end ] || { echo "timeout waiting for: $1" >&2; return 1; }
    grep -q 'FATAL EXCEPTION' "$LOG" && { echo "app crashed" >&2; return 1; }
    sleep 1
  done
}

adb shell am start -n "$ACTIVITY" >/dev/null
wait_for 'engine ready|WORKER ERROR' 120 || true

for action in "${ACTIONS[@]}"; do
  echo "== $action"
  adb shell am start -n "$ACTIVITY" --es action "$action" >/dev/null
  case $action in
    create) wait_for 'created:|create failed' 120 || true ;;
    unlock) wait_for 'unlocked:|unlock failed' 120 || true ;;
    sync) wait_for 'sync started|sync failed' 60 || true; wait_for 'balances: synced=' 600 || true ;;
    balances) wait_for 'balances failed|balances: synced=' 60 || true ;;
  esac
done
sleep 2
echo "== log ($LOG)"
cat "$LOG"
