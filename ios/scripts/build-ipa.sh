#!/usr/bin/env bash
# =============================================================================
#  Build the roundtable iOS app as an .ipa (run on a Mac with Xcode, or in CI).
#
#  Unsigned (default) — for sideloading with Sideloadly / AltStore, which sign it
#  with your own Apple ID when they install it:
#     bash scripts/build-ipa.sh
#
#  Signed — needs an Apple Developer account, and Xcode signed in to it
#  (Xcode > Settings > Accounts):
#     TEAM_ID=ABCDE12345 bash scripts/build-ipa.sh
#     TEAM_ID=ABCDE12345 EXPORT_METHOD=release-testing bash scripts/build-ipa.sh
#
#  Options (environment variables):
#     RT_SERVER_URL   server the app opens          (default https://round-table.site)
#     TEAM_ID         Apple Developer Team ID       (set it to make a signed build)
#     EXPORT_METHOD   app-store-connect (TestFlight / App Store, default),
#                     release-testing (ad hoc: registered devices), debugging (development)
#
#  Output: build/roundtable.ipa  (signed)  or  build/roundtable-unsigned.ipa
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER_URL="${RT_SERVER_URL:-https://round-table.site}"
EXPORT_METHOD="${EXPORT_METHOD:-app-store-connect}"
# Domain whose /join links (the QR code) open the app via universal links, e.g. round-table.site
LINK_DOMAIN="$(printf '%s' "$SERVER_URL" | sed -E 's|^[a-zA-Z]+://||; s|[:/].*$||')"

command -v xcodebuild >/dev/null || { echo "xcodebuild not found — this needs a Mac with Xcode installed."; exit 1; }
command -v xcodegen >/dev/null || { echo "XcodeGen not found. Install it with: brew install xcodegen"; exit 1; }

echo "==> Generating Roundtable.xcodeproj"
xcodegen generate --quiet

mkdir -p build

if [[ -n "${TEAM_ID:-}" ]]; then
  echo "==> Archiving signed build (team $TEAM_ID, server $SERVER_URL)"
  xcodebuild -project Roundtable.xcodeproj -scheme Roundtable -configuration Release \
    -destination 'generic/platform=iOS' -archivePath build/Roundtable.xcarchive \
    DEVELOPMENT_TEAM="$TEAM_ID" RT_SERVER_URL="$SERVER_URL" RT_LINK_DOMAIN="$LINK_DOMAIN" \
    -allowProvisioningUpdates -quiet archive

  cat > build/ExportOptions.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>${EXPORT_METHOD}</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>destination</key><string>export</string>
</dict>
</plist>
EOF

  echo "==> Exporting IPA ($EXPORT_METHOD)"
  rm -rf build/export
  xcodebuild -exportArchive -archivePath build/Roundtable.xcarchive -exportPath build/export \
    -exportOptionsPlist build/ExportOptions.plist -allowProvisioningUpdates -quiet
  cp build/export/*.ipa build/roundtable.ipa
  echo "==> Done: ios/build/roundtable.ipa"

  BUNDLE_ID="$(xcodebuild -project Roundtable.xcodeproj -target Roundtable -showBuildSettings 2>/dev/null \
    | awk -F' = ' '/ PRODUCT_BUNDLE_IDENTIFIER /{print $2; exit}')"
  echo ""
  echo "To make the join QR code open this app straight from the Camera, add this line to"
  echo "/etc/roundtable.env on your server, then run: sudo systemctl restart roundtable"
  echo "  APPLE_APP_ID=${TEAM_ID}.${BUNDLE_ID}"
else
  echo "==> Building unsigned app (server $SERVER_URL)"
  xcodebuild -project Roundtable.xcodeproj -scheme Roundtable -configuration Release \
    -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build/DerivedData \
    RT_SERVER_URL="$SERVER_URL" RT_LINK_DOMAIN="$LINK_DOMAIN" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
    -quiet build

  APP="build/DerivedData/Build/Products/Release-iphoneos/Roundtable.app"
  [[ -d "$APP" ]] || { echo "Build failed: $APP not found"; exit 1; }
  rm -rf build/Payload build/roundtable-unsigned.ipa
  mkdir -p build/Payload
  cp -R "$APP" build/Payload/
  (cd build && zip -qry roundtable-unsigned.ipa Payload)
  rm -rf build/Payload
  echo "==> Done: ios/build/roundtable-unsigned.ipa"
fi
