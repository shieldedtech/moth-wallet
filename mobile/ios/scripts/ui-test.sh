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

# Answer Face ID prompts for as long as the tests run.
( while true; do xcrun simctl spawn "$SIM" notifyutil -p com.apple.BiometricKit_Sim.pearl.match >/dev/null 2>&1; sleep 2; done ) &
MATCHER=$!
trap 'kill $MATCHER $SERVER 2>/dev/null' EXIT

DEST="platform=iOS Simulator,id=$SIM"
xcodebuild build-for-testing -project Moth.xcodeproj -scheme Moth -configuration Debug -destination "$DEST" -derivedDataPath build/DerivedData
# Each class starts from a fresh install, so none depends on another's wallet.
for class in ${TESTS:-OnboardingTests AccountsTests ConnectorTests FeaturesTests SecurityTests}; do
  xcrun simctl uninstall "$SIM" bob.shielded.moth 2>/dev/null || true
  # Keychain items outlive an uninstall, and Moth never reuses a name that has one.
  xcrun simctl keychain "$SIM" reset
  xcodebuild test-without-building -project Moth.xcodeproj -scheme Moth -configuration Debug -destination "$DEST" \
    -derivedDataPath build/DerivedData -only-testing:"MothUITests/$class"
done
