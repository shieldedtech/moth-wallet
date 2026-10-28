#!/usr/bin/env bash
# Runs Moth's UI tests on an Android emulator, from a fresh install of a separate app ID
# (io.shielded.moth.uitest), answering each fingerprint prompt the tests ask about with
# `adb emu finger touch`. Needs network access (the test syncs on preprod).
#
#   scripts/ui-test.sh                      # sets up and boots the emulator (AVD, PORT, WINDOW)
#   ANDROID_SERIAL=emulator-5556 scripts/ui-test.sh   # a running emulator, already set up
#   TESTS=OnboardingTests scripts/ui-test.sh
#
# Only emulators are used: a phone's fingerprint cannot be faked, and a phone may hold a real
# wallet. Without ANDROID_SERIAL, scripts/emulator-setup.sh creates and boots one with the screen
# lock PIN and fingerprint the tests need, as the iOS script does with simctl. Build the engine
# bundle and the native library for the emulator's ABI first
# (ABIS="arm64-v8a x86_64" scripts/build-native.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
export ANDROID_HOME=$SDK PATH="$SDK/platform-tools:$SDK/emulator:$HOME/.cargo/bin:$PATH"
APP_ID=io.shielded.moth.uitest
GRADLE=${GRADLE:-gradle}

# Diagnostics for a failed run, which CI uploads: a screenshot per failed test, Gradle's test
# reports per failed class, and for the run the full logcat and the emulator's own log.
RESULTS=build/ui-test-results
rm -rf "$RESULTS"
mkdir -p "$RESULTS"
# emulator-setup.sh writes its emulator's output here.
EMULATOR_LOG=${TMPDIR:-/tmp}/emulator-${AVD:-moth-ui}.log
# Best effort: the emulator may be gone, and a missing piece must not hide the test failure.
collect_class() {
  local dir=$RESULTS/$1
  mkdir -p "$dir"
  cp -r app/build/reports/androidTests/connected "$dir/reports" 2>/dev/null || true
  cp -r app/build/outputs/androidTest-results "$dir/androidTest-results" 2>/dev/null || true
}
collect_run() {
  timeout 60 adb logcat -d -v time > "$RESULTS/logcat.txt" 2>/dev/null || true
  [ ! -f "$EMULATOR_LOG" ] || cp "$EMULATOR_LOG" "$RESULTS/"
  echo "ui-test: diagnostics in mobile/android/$RESULTS" >&2
}

[ -f app/src/main/assets/engine/index.html ] || { echo "error: run scripts/bundle-engine.sh first" >&2; exit 1; }

case "${ANDROID_SERIAL:-}" in
  emulator-*) serial=$ANDROID_SERIAL ;;
  # A plain assignment, so a setup failure stops this script (set -e, pipefail).
  "") serial=$(scripts/emulator-setup.sh | tail -1) ;;
  *) echo "error: ANDROID_SERIAL=$ANDROID_SERIAL is not an emulator" >&2; exit 1 ;;
esac
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

# The app's and the tests' log lines go to stderr as they come, so CI shows the progress. The
# tests log "fingerprint" while a prompt they expect is open; touch the sensor for each.
adb logcat -c
( adb logcat -v time -s MothSpike:I MothUITest:I TestRunner:I | while read -r line; do
    line=${line%$'\r'}
    case $line in
      *"): fingerprint") adb emu finger touch 1 >/dev/null ;;
      # A failed test holds its screen for a moment (HoldScreenOnFailure); capture it.
      *"): screenshot "*)
        echo "$line" >&2
        test=${line##*screenshot }
        adb exec-out screencap -p > "$RESULTS/${test//[^A-Za-z0-9_.-]/_}.png" 2>/dev/null || true ;;
      *) echo "$line" >&2 ;;
    esac
  done ) &
RESPONDER=$!
# Its children first: once the subshell is gone they are no longer found by parent.
trap 'pkill -P $RESPONDER 2>/dev/null; kill $RESPONDER 2>/dev/null || true' EXIT

# Each class starts from a fresh install, so none depends on another's wallet; uninstalling
# also deletes the app's Keystore keys. A failing class does not stop the others, so one flaky
# test does not hide the rest; the script fails at the end.
failed=()
for class in ${TESTS:-OnboardingTests}; do
  echo "ui-test: $class on $serial ($abi), starting $(date -u +%H:%M:%S) UTC" >&2
  adb uninstall "$APP_ID" >/dev/null 2>&1 || true
  if ! "$GRADLE" -q connectedDebugAndroidTest -PmothAppSuffix=.uitest -PmothAbis="$abi" \
    -Pandroid.testInstrumentationRunnerArguments.class="io.shielded.moth.$class"; then
    failed+=("$class")
    collect_class "$class"
  fi
done
[ ${#failed[@]} -eq 0 ] || { collect_run; echo "error: failed: ${failed[*]}" >&2; exit 1; }
