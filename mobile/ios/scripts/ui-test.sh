#!/usr/bin/env bash
# Runs Moth's UI tests on a simulator, from a fresh install, with Face ID enrolled and its
# prompts answered with a match unless a test asks for a non-matching face. Needs network access
# (the tests sync on preprod).
#
#   SIMULATOR="iPhone 17 Pro" scripts/ui-test.sh    (default: the first available iPhone)
#   SUITE=smoke scripts/ui-test.sh                  (default: full)
#   TESTS="LifecycleTests IsolationTests" scripts/ui-test.sh
#
# Each class takes about 5 minutes on CI, so pull requests run only the smoke suite: the core
# wallet flow and the DApp connector. The full suite runs on main, nightly and on demand.
set -euo pipefail
cd "$(dirname "$0")/.."
SMOKE="OnboardingTests ConnectorTests"
FULL="$SMOKE AccountsTests FeaturesTests SecurityTests FaceIDFailureTests ConnectorRejectTests LifecycleTests SyncInterruptTests IsolationTests RecoveryPhraseLeakTests"
case ${SUITE:-full} in
  smoke) CLASSES=$SMOKE ;;
  full) CLASSES=$FULL ;;
  *) echo "SUITE must be smoke or full, not '$SUITE'" >&2; exit 1 ;;
esac
CLASSES=${TESTS:-$CLASSES}

# Moth's prover listens on 127.0.0.1:6300 in the simulator, which shares the Mac's loopback. Another
# server there (a local devnet's proof server, say) would answer the isolation probes instead.
case " $CLASSES " in *" IsolationTests "*)
  other=$(lsof -nP -iTCP:6300 -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | grep -vx Moth || true)
  [ -z "$other" ] || { echo "error: port 6300 is in use by: $(echo $other); stop it before the isolation tests" >&2; exit 1; } ;;
esac

# The leak check is only as good as the scan, so test the scan before relying on it.
case " $CLASSES " in *" RecoveryPhraseLeakTests "*) python3 -I scripts/test_phrase_scan.py ;; esac

SIM=$(xcrun simctl list devices available -j | python3 -I -c "
import json, sys
want = sys.argv[1]
for runtime, devices in sorted(json.load(sys.stdin)['devices'].items(), reverse=True):
    if 'iOS' not in runtime: continue
    for d in devices:
        if (d['name'] == want) if want else d['name'].startswith('iPhone'):
            print(d['udid']); sys.exit()
sys.exit('no available simulator ' + (want or 'iPhone'))" "${SIMULATOR:-}")

xcrun simctl boot "$SIM" 2>/dev/null || true
xcrun simctl bootstatus "$SIM" -b >/dev/null
xcrun simctl spawn "$SIM" notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
xcrun simctl spawn "$SIM" notifyutil -p com.apple.BiometricKit.enrollmentChanged

# moth's mock DApp, for the connector test; the simulator shares the Mac's loopback.
MOCK_DAPP=../../packages/mock-dapp/dist
[ -f "$MOCK_DAPP/index.html" ] || { echo "build the mock DApp first: yarn workspace @shieldedtech/moth-mock-dapp build" >&2; exit 1; }
python3 -I -m http.server 5174 --bind 127.0.0.1 --directory "$MOCK_DAPP" >/dev/null 2>&1 &
SERVER=$!

# Pages for the isolation tests: an iframe that calls the connector, and loopback probes.
python3 -I -m http.server 5175 --bind 127.0.0.1 --directory MothUITests/Fixtures >/dev/null 2>&1 &
FIXTURES=$!

# Answer Face ID prompts for as long as the tests run. A test picks the answer by writing
# match or nomatch to $CONTROL/faceid (see FaceID in MothUITests); the default is match.
# After each post the answer sent goes to $CONTROL/faceid.sent. A post can take seconds on a busy
# runner, so a test waits for that file to show its new answer: an earlier answer still being sent
# could otherwise reach a prompt the test has just opened.
CONTROL=$(mktemp -d)
export TEST_RUNNER_MOTH_CONTROL=$CONTROL
( while true; do
    answer=$(cat "$CONTROL/faceid" 2>/dev/null || echo match)
    case $answer in
      match) xcrun simctl spawn "$SIM" notifyutil -p com.apple.BiometricKit_Sim.pearl.match >/dev/null 2>&1 ;;
      nomatch) xcrun simctl spawn "$SIM" notifyutil -p com.apple.BiometricKit_Sim.pearl.nomatch >/dev/null 2>&1 ;;
    esac
    echo "$answer" > "$CONTROL/faceid.sending" && mv "$CONTROL/faceid.sending" "$CONTROL/faceid.sent"
    sleep 2
  done ) &
MATCHER=$!
trap 'kill $MATCHER $SERVER $FIXTURES 2>/dev/null; rm -rf "$CONTROL"' EXIT

DEST="platform=iOS Simulator,id=$SIM"
xcodebuild build-for-testing -project Moth.xcodeproj -scheme Moth -configuration Debug -destination "$DEST" -derivedDataPath build/DerivedData
# One result bundle per class (screenshots, logs), which CI uploads when a test fails.
RESULTS=build/TestResults
rm -rf "$RESULTS"
mkdir -p "$RESULTS"
# Each class starts from a fresh install, so none depends on another's wallet. A failing class
# does not stop the others, so one flaky test does not hide the rest; the script fails at the end.
failed=()
for class in $CLASSES; do
  rm -f "$CONTROL/faceid" "$CONTROL/faceid.sent"
  xcrun simctl uninstall "$SIM" bob.shielded.moth 2>/dev/null || true
  # Keychain items outlive an uninstall, and Moth never reuses a name that has one.
  xcrun simctl keychain "$SIM" reset
  start=$(date '+%Y-%m-%d %H:%M:%S')
  xcodebuild test-without-building -project Moth.xcodeproj -scheme Moth -configuration Debug -destination "$DEST" \
    -derivedDataPath build/DerivedData -only-testing:"MothUITests/$class" \
    -resultBundlePath "$RESULTS/$class.xcresult" || {
      failed+=("$class")
      # Whether WebKit's processes started, for an engine that never loaded.
      xcrun simctl spawn "$SIM" log show --last 10m --style compact \
        --predicate 'subsystem BEGINSWITH "com.apple.WebKit" OR process BEGINSWITH "com.apple.WebKit"' \
        > "$RESULTS/$class.webkit.log" 2>&1 || true
    }
  # The app's own log (engine load and failures), kept until the next class uninstalls it.
  DATA=$(xcrun simctl get_app_container "$SIM" bob.shielded.moth data 2>/dev/null) &&
    cp "$DATA/Documents/moth-debug.log" "$RESULTS/$class.moth-debug.log" 2>/dev/null || true
  # A test that saved the phrase asks for the logs and the app's files to be searched for it.
  # XCTest logs the text it types, so its own subsystem is left out. A leak, or a scan that could
  # not look everywhere, fails the class like a failed test does, rather than stopping the run.
  if [ -f "$CONTROL/phrase" ]; then
    xcrun simctl spawn "$SIM" log show --start "$start" --info --debug --style compact \
      --predicate 'subsystem != "com.apple.dt.xctest" AND process != "testmanagerd"' > "$CONTROL/syslog" ||
      failed+=("$class (system log not read)")
    DATA=$(xcrun simctl get_app_container "$SIM" bob.shielded.moth data 2>/dev/null) || DATA=
    scan=0
    python3 -I scripts/phrase-scan.py "$CONTROL/phrase" "$CONTROL/syslog" "$DATA" || scan=$?
    case $scan in
      0) ;;
      1) failed+=("$class (recovery phrase found)") ;;
      *) failed+=("$class (phrase scan failed)") ;;
    esac
    rm -f "$CONTROL/phrase" "$CONTROL/syslog"
  fi
done
[ ${#failed[@]} -eq 0 ] || { echo "error: failed: ${failed[*]}; results in mobile/ios/$RESULTS" >&2; exit 1; }
