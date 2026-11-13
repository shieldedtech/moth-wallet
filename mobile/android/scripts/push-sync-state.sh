#!/usr/bin/env bash
# Debug builds only. Pushes a wallet's sync state from this computer's moth home to the phone,
# so restoring the same recovery phrase in the app skips the scan from genesis.
#
#   scripts/push-sync-state.sh <wallet> [network]
#
# Restore and sync the phrase with the moth CLI or TUI first, and stop it before pushing, so
# the files are not half written. The app checks the state's address against the phrase,
# loads it during restore and deletes the pushed copy.
# Env: MOTH_HOME (default ~/.moth), APP_ID (default io.shielded.moth), ANDROID_SERIAL.
set -euo pipefail
WALLET=${1:?usage: push-sync-state.sh <wallet> [network]}
NETWORK=${2:-preprod}
HOME_DIR=${MOTH_HOME:-$HOME/.moth}
APP_ID=${APP_ID:-io.shielded.moth}
SRC="$HOME_DIR/sync/$NETWORK/$WALLET"
[ -f "$SRC/unshielded.dat" ] || { echo "error: no synced state at $SRC" >&2; exit 1; }
DEST="/sdcard/Android/data/$APP_ID/files/sync-import/$NETWORK"
adb shell "rm -rf '$DEST' && mkdir -p '$DEST/sync' '$DEST/witness'"
adb push "$SRC/." "$DEST/sync/"
[ -d "$HOME_DIR/witness/$NETWORK/$WALLET" ] && adb push "$HOME_DIR/witness/$NETWORK/$WALLET/." "$DEST/witness/"
echo "Pushed. In the app, choose Restore and enter the same recovery phrase."
