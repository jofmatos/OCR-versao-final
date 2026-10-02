#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_dir=".cache/mac-build"
app_dir="$build_dir/Lume OCR Mac.app"
mkdir -p "$app_dir/Contents/MacOS"
mac_sdk="$(xcrun --sdk macosx --show-sdk-path)"
for architecture in arm64 x86_64; do
  xcrun swiftc native/mac-vision/main.swift -swift-version 5 -O -sdk "$mac_sdk" -target "${architecture}-apple-macos13.0" -o "$build_dir/LumeOCRMac-$architecture"
done
lipo -create "$build_dir/LumeOCRMac-arm64" "$build_dir/LumeOCRMac-x86_64" -output "$app_dir/Contents/MacOS/LumeOCRMac"
cat > "$app_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>LumeOCRMac</string>
<key>CFBundleIdentifier</key><string>io.github.jofmatos.lume-ocr-mac</string>
<key>CFBundleName</key><string>Lume OCR Mac</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$app_dir"
codesign --verify --strict "$app_dir"
ditto -c -k --sequesterRsrc --keepParent "$app_dir" "$build_dir/Lume-OCR-Mac.zip"
