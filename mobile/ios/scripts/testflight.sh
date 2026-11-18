#!/usr/bin/env bash
# Archives a Release build of Moth and uploads it to App Store Connect for TestFlight.
#
#   TEAM_ID=… scripts/testflight.sh
#   TEAM_ID=… ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=/path/AuthKey_XXXX.p8 scripts/testflight.sh
#
# TEAM_ID is the Apple Developer team that owns bob.shielded.moth. Without an API key, signing
# and upload use the account signed in to Xcode; with one (App Store Connect → Users and
# Access → Integrations, App Manager role or higher) it runs unattended, e.g. in CI.
# Each upload needs a new build number; it defaults to the UTC time (BUILD_NUMBER overrides).
# Run after `yarn install && yarn build` at the repo root.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TEAM_ID:?set TEAM_ID to the Apple Developer team id that owns bob.shielded.moth}"
BUILD=${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}
ARCHIVE=build/Moth.xcarchive
AUTH=(-allowProvisioningUpdates)
if [ -n "${ASC_KEY_ID:-}" ]; then
  : "${ASC_ISSUER_ID:?set ASC_ISSUER_ID with ASC_KEY_ID}"
  : "${ASC_KEY_PATH:?set ASC_KEY_PATH with ASC_KEY_ID}"
  AUTH+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

scripts/build-engine.sh
rm -rf "$ARCHIVE" build/export
xcodebuild archive -project Moth.xcodeproj -scheme Moth -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM_ID" CURRENT_PROJECT_VERSION="$BUILD" "${AUTH[@]}"

sed "s/TEAM_ID_PLACEHOLDER/$TEAM_ID/" scripts/ExportOptions.plist > build/ExportOptions.plist
# With destination=upload, exporting sends the build to App Store Connect.
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist build/ExportOptions.plist \
  -exportPath build/export "${AUTH[@]}"
echo "uploaded Moth build $BUILD; it appears in TestFlight once App Store Connect finishes processing"
