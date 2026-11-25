#!/bin/bash
# Builds a universal (Apple silicon + Intel) Mimo.app and Mimo.dmg into dist/
set -e
cd "$(dirname "$0")/.."
SRC=Sources; OUT=dist; BUILD=build
rm -rf "$OUT" "$BUILD"; mkdir -p "$OUT" "$BUILD"
APP="$OUT/Mimo.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc "$SRC/render.swift" -o "$BUILD/render"
cp "$SRC/menu.svg" "$APP/Contents/Resources/menu.svg"
"$BUILD/render" "$SRC/icon.svg" "$APP/Contents/Resources/mimo.png" 256
mkdir -p "$BUILD/Mimo.iconset"
for s in 16 32 128 256 512; do
  "$BUILD/render" "$SRC/icon.svg" "$BUILD/Mimo.iconset/icon_${s}x${s}.png" $s
  "$BUILD/render" "$SRC/icon.svg" "$BUILD/Mimo.iconset/icon_${s}x${s}@2x.png" $((s*2))
done
iconutil -c icns "$BUILD/Mimo.iconset" -o "$APP/Contents/Resources/Mimo.icns"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Mimo</string>
<key>CFBundleDisplayName</key><string>Mimo</string>
<key>CFBundleIdentifier</key><string>com.great.mimo</string>
<key>CFBundleExecutable</key><string>Mimo</string>
<key>CFBundleIconFile</key><string>Mimo</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>12</string>
<key>CFBundleShortVersionString</key><string>1.5.3</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
PL
swiftc -O -parse-as-library -target x86_64-apple-macos13.0 "$SRC/main.swift" -o "$BUILD/Mimo-x86"
swiftc -O -parse-as-library -target arm64-apple-macos13.0 "$SRC/main.swift" -o "$BUILD/Mimo-arm"
lipo -create "$BUILD/Mimo-x86" "$BUILD/Mimo-arm" -output "$APP/Contents/MacOS/Mimo"
# Sign with the Developer ID certificate when it's in the keychain, otherwise ad-hoc (local builds).
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')
if [ -n "$IDENTITY" ]; then
  echo "Signing with: $IDENTITY"
  codesign --force --options runtime --timestamp -s "$IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP"
else
  echo "No Developer ID certificate found: ad-hoc signing (Macs will show a warning)"
  codesign --force --deep -s - "$APP"
fi
STAGE="$BUILD/dmg"; mkdir -p "$STAGE"; cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname Mimo -srcfolder "$STAGE" -ov -format UDZO "$OUT/Mimo.dmg"
if [ -n "$IDENTITY" ]; then
  codesign --force --timestamp -s "$IDENTITY" "$OUT/Mimo.dmg"
  # Apple's malware check (notarization), then attach the approval to the DMG so it works offline.
  if xcrun notarytool history --keychain-profile mimo-notary >/dev/null 2>&1; then
    xcrun notarytool submit "$OUT/Mimo.dmg" --keychain-profile mimo-notary --wait
    xcrun stapler staple "$OUT/Mimo.dmg"
    spctl -a -t open --context context:primary-signature -v "$OUT/Mimo.dmg" 2>&1 | tail -1
  else
    echo "WARNING: notarization profile 'mimo-notary' missing: DMG is signed but NOT notarized"
  fi
fi
echo "Built $OUT/Mimo.dmg"
