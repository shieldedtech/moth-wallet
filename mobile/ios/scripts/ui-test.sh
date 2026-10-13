#!/usr/bin/env bash
# Runs Moth's UI tests on a simulator, from a fresh install, with Face ID enrolled and every
# Face ID prompt answered with a match. Needs network access (the test syncs on preprod).
#
#   SIMULATOR="iPhone 17 Pro" scripts/ui-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=${SIMULATOR:-iPhone 17 Pro}
SIM=$(xcrun simctl list devices available -j | python3 -I -c "
import json, sys
name = sys.argv[1]
for devices in json.load(sys.stdin)['devices'].values():
    for d in devices:
        if d['name'] == name: print(d['udid']); sys.exit()
sys.exit('no available simulator named ' + name)" "$NAME")

xcrun simctl boot "$SIM" 2>/dev/null || true
xcrun simctl bootstatus "$SIM" -b >/dev/null
xcrun simctl uninstall "$SIM" io.shielded.moth 2>/dev/null || true
xcrun simctl spawn "$SIM" notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
xcrun simctl spawn "$SIM" notifyutil -p com.apple.BiometricKit.enrollmentChanged

# Answer Face ID prompts for as long as the tests run.
( while true; do xcrun simctl spawn "$SIM" notifyutil -p com.apple.BiometricKit_Sim.pearl.match >/dev/null 2>&1; sleep 2; done ) &
MATCHER=$!
trap 'kill $MATCHER 2>/dev/null' EXIT

xcodebuild test -project Moth.xcodeproj -scheme Moth -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath build/DerivedData
