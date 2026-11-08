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
<key>CFBundleVersion</key><string>7</string>
<key>CFBundleShortVersionString</key><string>1.4.1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
PL
swiftc -O -parse-as-library -target x86_64-apple-macos13.0 "$SRC/main.swift" -o "$BUILD/Mimo-x86"
swiftc -O -parse-as-library -target arm64-apple-macos13.0 "$SRC/main.swift" -o "$BUILD/Mimo-arm"
lipo -create "$BUILD/Mimo-x86" "$BUILD/Mimo-arm" -output "$APP/Contents/MacOS/Mimo"
codesign --force --deep -s - "$APP"
STAGE="$BUILD/dmg"; mkdir -p "$STAGE"; cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname Mimo -srcfolder "$STAGE" -ov -format UDZO "$OUT/Mimo.dmg"
echo "Built $OUT/Mimo.dmg"
