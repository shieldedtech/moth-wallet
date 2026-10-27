#!/usr/bin/env bash
# Runs Moth's UI tests on an Android emulator, from a fresh install of a separate app ID
# (io.shielded.moth.uitest), answering each fingerprint prompt the tests ask about with
# `adb emu finger touch`. Needs network access (the test syncs on preprod).
#
#   scripts/ui-test.sh                      # the running emulator, else boots $AVD
#   AVD=moth-api34 scripts/ui-test.sh
#   TESTS=OnboardingTests scripts/ui-test.sh
#
# Only emulators are used: a phone's fingerprint cannot be faked, and a phone may hold a real
# wallet. The emulator needs a screen lock PIN and fingerprint 1 enrolled; see the README's
# "UI tests". Build the engine bundle and the native library for the emulator's ABI first
# (ABIS="arm64-v8a x86_64" scripts/build-native.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
export ANDROID_HOME=$SDK PATH="$SDK/platform-tools:$SDK/emulator:$HOME/.cargo/bin:$PATH"
APP_ID=io.shielded.moth.uitest
GRADLE=${GRADLE:-gradle}

[ -f app/src/main/assets/engine/index.html ] || { echo "error: run scripts/bundle-engine.sh first" >&2; exit 1; }

serial=$(adb devices | awk '$1 ~ /^emulator-/ && $2 == "device" { print $1; exit }')
if [ -z "$serial" ]; then
  [ -n "${AVD:-}" ] || { echo "error: no emulator running; start one or set AVD (emulator -list-avds)" >&2; exit 1; }
  emulator -avd "$AVD" -no-snapshot-save -no-boot-anim >/dev/null 2>&1 &
  until serial=$(adb devices | awk '$1 ~ /^emulator-/ && $2 == "device" { print $1; exit }') && [ -n "$serial" ]; do sleep 2; done
fi
# Gradle's connected tests and every adb call below use this device only.
export ANDROID_SERIAL=$serial
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done

# Package the native library for the emulator's own ABI, so the prover runs at full speed.
abi=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')
[ -f "app/src/main/jniLibs/$abi/libmoth_android.so" ] || { echo "error: no native library for $abi; run ABIS=$abi scripts/build-native.sh" >&2; exit 1; }

# The Keystore key works only while the screen is unlocked; keep it on once it is.
adb shell svc power stayon true
adb shell input keyevent KEYCODE_WAKEUP
echo "using $serial; if its screen is locked, unlock it now (PIN)" >&2

# The tests log "fingerprint" while a prompt they expect is open; touch the sensor for each.
adb logcat -c
( adb logcat -v raw -s MothUITest:I | while read -r line; do
    [ "${line%$'\r'}" = fingerprint ] && adb emu finger touch 1 >/dev/null
  done ) &
RESPONDER=$!
trap 'kill $RESPONDER 2>/dev/null; pkill -P $RESPONDER 2>/dev/null || true' EXIT

# Each class starts from a fresh install, so none depends on another's wallet; uninstalling
# also deletes the app's Keystore keys.
for class in ${TESTS:-OnboardingTests}; do
  adb uninstall "$APP_ID" >/dev/null 2>&1 || true
  "$GRADLE" -q connectedDebugAndroidTest -PmothAppSuffix=.uitest -PmothAbis="$abi" \
    -Pandroid.testInstrumentationRunnerArguments.class="io.shielded.moth.$class"
done
