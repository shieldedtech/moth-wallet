#!/usr/bin/env bash
# Renders brand/app-icon.svg to the app icon in Moth/Assets.xcassets. Needs rsvg-convert
# (`brew install librsvg`). iOS rejects icons with an alpha channel, so the render is redrawn
# into an opaque bitmap.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=Moth/Assets.xcassets/AppIcon.appiconset/AppIcon.png
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

rsvg-convert -w 1024 -h 1024 brand/app-icon.svg -o "$TMP/icon.png"
cat > "$TMP/flatten.swift" <<'SWIFT'
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
CGImageDestinationFinalize(destination)
SWIFT
swift "$TMP/flatten.swift" "$TMP/icon.png" "$OUT"
# The same tile, smaller, is the logo on the welcome and lock screens.
sips -z 512 512 "$OUT" --out Moth/Assets.xcassets/MothLogo.imageset/MothLogo.png >/dev/null
echo "wrote $OUT and the in-app logo"
