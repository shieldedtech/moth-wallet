#!/usr/bin/env bash
# Creates (once) and boots the x86_64 emulator scripts/ui-test.sh runs on, with the screen lock
# PIN and fingerprint the tests need. ui-test.sh runs it when no ANDROID_SERIAL is given; on its
# own it prepares an emulator for trying the app by hand. Locally it reuses the AVD.
#
#   scripts/emulator-setup.sh                      # AVD moth-ui on port 5554, no window
#   WINDOW=1 PORT=5556 AVD=moth-ui scripts/emulator-setup.sh
#
# Prints the emulator's serial (emulator-$PORT) last.
set -euo pipefail
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
export PATH="$SDK/platform-tools:$SDK/emulator:$SDK/cmdline-tools/latest/bin:$PATH"
AVD=${AVD:-moth-ui}
PORT=${PORT:-5554}
PIN=1111
# API 36 (WebView 133) is the newest image that runs here; API 37 crash-loops (README "UI tests").
IMAGE="system-images;android-36;google_apis;x86_64"
export ANDROID_SERIAL=emulator-$PORT
EMULATOR_LOG=${TMPDIR:-/tmp}/emulator-$AVD.log
START=$SECONDS

# Progress on stderr, so CI shows how far setup got; stdout carries only the serial.
log() { echo "emulator-setup [$(( SECONDS - START ))s] $*" >&2; }
fail() {
  log "error: $*"
  [ ! -f "$EMULATOR_LOG" ] || { echo "--- end of $EMULATOR_LOG" >&2; tail -40 "$EMULATOR_LOG" >&2; }
  exit 1
}
# Runs "$@" every 2 s until it succeeds; gives up after $1 seconds, or as soon as an emulator
# this script started has exited.
wait_until() {
  local limit=$1 what=$2
  shift 2
  local end=$(( SECONDS + limit ))
  until "$@" >/dev/null 2>&1; do
    [ -z "${EMULATOR_PID:-}" ] || kill -0 "$EMULATOR_PID" 2>/dev/null || fail "the emulator exited while waiting for $what"
    [ $SECONDS -lt $end ] || fail "no $what after ${limit}s"
    sleep 2
  done
  log "$what"
}

if ! emulator -list-avds 2>/dev/null | grep -x "$AVD" >/dev/null; then
  log "installing the emulator and $IMAGE"
  # sdkmanager can exit 0 without installing, so check for the image; its log explains why.
  log=${TMPDIR:-/tmp}/sdkmanager.log
  # yes ends on SIGPIPE when sdkmanager exits, which pipefail would report as a failure.
  { yes 2>/dev/null || true; } | sdkmanager --install emulator "$IMAGE" > "$log" 2>&1 || true
  if [ ! -f "$SDK/${IMAGE//;//}/system.img" ] || [ ! -x "$SDK/emulator/emulator" ]; then
    tail -30 "$log" >&2
    fail "sdkmanager did not install emulator and $IMAGE into $SDK"
  fi
  log "creating AVD $AVD"
  echo no | avdmanager create avd -n "$AVD" -k "$IMAGE" -d pixel_6 >&2
  dir=$(avdmanager list avd 2>/dev/null | awk -v n="$AVD" '$1 == "Name:" { f = ($2 == n) } f && $1 == "Path:" { print $2; exit }')
  [ -f "$dir/config.ini" ] || fail "avdmanager did not create $AVD"
  # avdmanager's 800 MB data partition fills up during the first boot.
  # grep and mv, not sed -i, whose syntax differs between GNU and BSD (macOS) sed.
  { grep -v '^disk.dataPartition.size' "$dir/config.ini" || true; echo "disk.dataPartition.size=8G"; } > "$dir/config.ini.new"
  mv "$dir/config.ini.new" "$dir/config.ini"
  # avdmanager and the emulator can disagree on where AVDs live (on GitHub's runners avdmanager
  # does not use ~/.android/avd), so point the emulator at the directory avdmanager used.
  export ANDROID_AVD_HOME=${dir%/*}
  log "AVD in $ANDROID_AVD_HOME"
fi

if ! adb devices | grep "^$ANDROID_SERIAL\s*device" >/dev/null; then
  flags=(-avd "$AVD" -port "$PORT" -no-boot-anim -no-snapshot -no-audio)
  [ -n "${WINDOW:-}" ] || flags+=(-no-window -gpu swiftshader_indirect)
  log "starting $AVD on port $PORT"
  emulator "${flags[@]}" > "$EMULATOR_LOG" 2>&1 &
  EMULATOR_PID=$!
fi
booted() { [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; }
wait_until 300 "$ANDROID_SERIAL online" adb shell true
wait_until 600 "boot completed" booted
# boot_completed comes before every system service is up.
wait_until 300 "system services up" adb shell locksettings get-disabled

# The Keystore key works only while the screen is unlocked; keep it on and unlocked. On a slow
# runner the lock screen can come up again after the PIN is set, so unlock before each step.
adb shell svc power stayon true
unlock() {
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell dumpsys window | grep "isKeyguardShowing=true" >/dev/null || return 0
  log "unlocking the screen"
  adb shell wm dismiss-keyguard
  sleep 2
  adb shell input text "$PIN"
  adb shell input keyevent KEYCODE_ENTER
  sleep 2
}
if ! adb shell locksettings verify --old "$PIN" >/dev/null 2>&1; then
  adb shell locksettings set-pin "$PIN" >/dev/null
  log "screen lock PIN set"
fi
unlock

# Settings' enrolment screens, driven by their text; the sensor is the emulator's. Each step
# waits for its screen, which can take a while after a cold boot.
# "count" is the number of fingerprints enrolled for user 0.
enrolled() { adb shell dumpsys fingerprint | grep '"prints":\[{"id":0,"count":[1-9]' >/dev/null; }
screen() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb shell cat /sdcard/ui.xml; }
# Waits up to a minute for a text matching the extended regex $1.
wait_for() {
  for _ in $(seq 1 30); do
    screen | grep -iE "text=\"($1)" >/dev/null && return 0
    sleep 2
  done
  return 1
}
tap() {
  local b
  b=$(screen | grep -io "text=\"$1\"[^>]*bounds=\"[^\"]*\"" | head -1 | grep -o '[0-9]\+' | tail -4 | tr '\n' ' ')
  [ -n "$b" ] || return 1
  set -- $b
  adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}
enrol() {
  unlock
  # A clean start: a failed attempt can leave Settings mid-enrolment, and am start would resume it.
  adb shell am force-stop com.android.settings
  adb shell am start -a android.settings.FINGERPRINT_ENROLL >/dev/null
  wait_for "(Re-enter|Enter|Confirm) your PIN" || return 1
  adb shell input text "$PIN"
  adb shell input keyevent KEYCODE_ENTER
  wait_for "I agree|More" || return 1
  for _ in $(seq 1 6); do tap "I agree" && break; tap "More" || true; sleep 1; done
  wait_for "Start|Touch the sensor" || return 1
  tap "Start" || true
  wait_for "Touch the sensor|Put your finger|Lift" || return 1
  for _ in $(seq 1 40); do
    enrolled && break
    # Touch only while the sensor screen asks for it; earlier touches are ignored.
    screen | grep -iE 'text="(Touch the sensor|Put your finger|Lift)' >/dev/null && adb emu finger touch 1 >/dev/null
    sleep 1.5
  done
  adb shell input keyevent KEYCODE_HOME
  enrolled
}
for attempt in 1 2; do
  enrolled && break
  log "enrolling a fingerprint (attempt $attempt)"
  enrol || adb shell input keyevent KEYCODE_HOME
done
if ! enrolled; then
  log "the screen shows:"
  screen | grep -o 'text="[^"]\+"' | head -5 >&2
  fail "fingerprint enrolment failed"
fi
unlock
log "ready: $ANDROID_SERIAL"

echo "$ANDROID_SERIAL"
