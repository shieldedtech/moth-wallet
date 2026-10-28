#!/usr/bin/env bash
# Creates (once) and boots the x86_64 emulator scripts/ui-test.sh runs on, with the screen lock
# PIN and fingerprint the tests need. CI runs it on a fresh runner; locally it reuses the AVD.
#
#   scripts/emulator-setup.sh                      # AVD moth-ui on port 5554, no window
#   WINDOW=1 PORT=5556 AVD=moth-ui scripts/emulator-setup.sh
#
# Prints the emulator's serial (emulator-$PORT) last; pass it to ui-test.sh as ANDROID_SERIAL.
set -euo pipefail
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
export PATH="$SDK/platform-tools:$SDK/emulator:$SDK/cmdline-tools/latest/bin:$PATH"
AVD=${AVD:-moth-ui}
PORT=${PORT:-5554}
PIN=1111
# API 36 (WebView 133) is the newest image that runs here; API 37 crash-loops (README "UI tests").
IMAGE="system-images;android-36;google_apis;x86_64"
AVD_DIR=${ANDROID_AVD_HOME:-$HOME/.android/avd}
export ANDROID_SERIAL=emulator-$PORT

if ! emulator -list-avds | grep -x "$AVD" >/dev/null; then
  # yes ends on SIGPIPE when sdkmanager exits, which pipefail would report as a failure.
  { yes || true; } | sdkmanager --install emulator "$IMAGE" >/dev/null
  echo no | avdmanager create avd -n "$AVD" -k "$IMAGE" -d pixel_6 >/dev/null
  # avdmanager's 800 MB data partition fills up during the first boot.
  sed -i '/^disk.dataPartition.size/d' "$AVD_DIR/$AVD.avd/config.ini"
  echo "disk.dataPartition.size=8G" >> "$AVD_DIR/$AVD.avd/config.ini"
fi

if ! adb devices | grep "^$ANDROID_SERIAL\s*device" >/dev/null; then
  flags=(-avd "$AVD" -port "$PORT" -no-boot-anim -no-snapshot -no-audio)
  [ -n "${WINDOW:-}" ] || flags+=(-no-window -gpu swiftshader_indirect)
  emulator "${flags[@]}" > "${TMPDIR:-/tmp}/emulator-$AVD.log" 2>&1 &
fi
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do sleep 2; done
# boot_completed comes before every system service is up.
until adb shell locksettings get-disabled >/dev/null 2>&1; do sleep 2; done

# The Keystore key works only while the screen is unlocked; keep it on and unlocked.
adb shell svc power stayon true
adb shell input keyevent KEYCODE_WAKEUP
if ! adb shell locksettings verify --old "$PIN" >/dev/null 2>&1; then
  adb shell locksettings set-pin "$PIN" >/dev/null
elif adb shell dumpsys window | grep "isKeyguardShowing=true" >/dev/null; then
  adb shell wm dismiss-keyguard
  sleep 1
  adb shell input text "$PIN"
  adb shell input keyevent KEYCODE_ENTER
fi

# Settings' enrolment screens, driven by their button text; the sensor is the emulator's.
# "count" is the number of fingerprints enrolled for user 0.
enrolled() { adb shell dumpsys fingerprint | grep '"prints":\[{"id":0,"count":[1-9]' >/dev/null; }
tap() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || return 1
  local b
  b=$(adb shell cat /sdcard/ui.xml | grep -io "text=\"$1\"[^>]*bounds=\"[^\"]*\"" | head -1 | grep -o '[0-9]\+' | tail -4 | tr '\n' ' ')
  [ -n "$b" ] || return 1
  set -- $b
  adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}
if ! enrolled; then
  adb shell am start -a android.settings.FINGERPRINT_ENROLL >/dev/null
  sleep 3
  adb shell input text "$PIN"
  adb shell input keyevent KEYCODE_ENTER
  sleep 3
  for _ in $(seq 1 6); do tap "I agree" && break; tap "More" || true; sleep 1; done
  sleep 2
  tap "Start" || true
  sleep 2
  for _ in $(seq 1 20); do
    enrolled && break
    adb emu finger touch 1 >/dev/null
    sleep 1.5
  done
  enrolled || { echo "error: fingerprint enrolment failed" >&2; exit 1; }
  adb shell input keyevent KEYCODE_HOME
fi
echo "$ANDROID_SERIAL"
