#!/usr/bin/env bash
# Runs Moth's UI tests on a simulator, from a fresh install, with Face ID enrolled and every
# Face ID prompt answered with a match. Needs network access (the test syncs on preprod).
#
#   SIMULATOR="iPhone 17 Pro" scripts/ui-test.sh    (default: the first available iPhone)
set -euo pipefail
cd "$(dirname "$0")/.."
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
CONTROL=$(mktemp -d)
export TEST_RUNNER_MOTH_CONTROL=$CONTROL
( while true; do
    case $(cat "$CONTROL/faceid" 2>/dev/null || echo match) in
      match) xcrun simctl spawn "$SIM" notifyutil -p com.apple.BiometricKit_Sim.pearl.match >/dev/null 2>&1 ;;
      nomatch) xcrun simctl spawn "$SIM" notifyutil -p com.apple.BiometricKit_Sim.pearl.nomatch >/dev/null 2>&1 ;;
    esac
    sleep 2
  done ) &
MATCHER=$!
trap 'kill $MATCHER $SERVER $FIXTURES 2>/dev/null; rm -rf "$CONTROL"' EXIT

DEST="platform=iOS Simulator,id=$SIM"
xcodebuild build-for-testing -project Moth.xcodeproj -scheme Moth -configuration Debug -destination "$DEST" -derivedDataPath build/DerivedData
# Each class starts from a fresh install, so none depends on another's wallet.
for class in ${TESTS:-OnboardingTests AccountsTests ConnectorTests FeaturesTests SecurityTests FaceIDFailureTests ConnectorRejectTests LifecycleTests SyncInterruptTests IsolationTests RecoveryPhraseLeakTests}; do
  rm -f "$CONTROL/faceid"
  xcrun simctl uninstall "$SIM" bob.shielded.moth 2>/dev/null || true
  # Keychain items outlive an uninstall, and Moth never reuses a name that has one.
  xcrun simctl keychain "$SIM" reset
  start=$(date '+%Y-%m-%d %H:%M:%S')
  xcodebuild test-without-building -project Moth.xcodeproj -scheme Moth -configuration Debug -destination "$DEST" \
    -derivedDataPath build/DerivedData -only-testing:"MothUITests/$class"
  # A test that saved the phrase asks for the logs and the app's files to be searched for it.
  # XCTest logs the text it types, so its own subsystem is left out.
  if [ -f "$CONTROL/phrase" ]; then
    xcrun simctl spawn "$SIM" log show --start "$start" --info --debug --style compact \
      --predicate 'subsystem != "com.apple.dt.xctest" AND process != "testmanagerd"' > "$CONTROL/syslog"
    python3 -I scripts/phrase-scan.py "$CONTROL/phrase" "$CONTROL/syslog" \
      "$(xcrun simctl get_app_container "$SIM" bob.shielded.moth data)" || { rm -f "$CONTROL/phrase" "$CONTROL/syslog"; exit 1; }
    rm -f "$CONTROL/phrase" "$CONTROL/syslog"
  fi
done
