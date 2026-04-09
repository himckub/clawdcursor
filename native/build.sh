#!/bin/bash
# Build script for ClawdCursor native helper (macOS only)
# Usage: ./build.sh [--adhoc]
#   --adhoc is now the DEFAULT behavior (required for TCC on macOS 26+)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔨 Building ClawdCursor native helper..."

# Build all targets in release mode
swift build -c release

# Get the build directory
BUILD_DIR=".build/release"

# Create the .app bundle structure
APP_DIR="ClawdCursor.app/Contents/MacOS"
mkdir -p "$APP_DIR"

# Copy binaries into the bundle
for binary in ClawdCursorHost clawdcursor-helper screenshot-helper permission-check; do
    if [ -f "$BUILD_DIR/$binary" ]; then
        cp "$BUILD_DIR/$binary" "$APP_DIR/"
        echo "   ✓ Copied $binary"
    else
        echo "   ⚠ Missing $binary (may be optional)"
    fi
done

echo "✅ Built ClawdCursor.app"

# Code signing (REQUIRED for TCC on macOS 26+ / Tahoe)
# Without signing, the app won't appear in System Settings privacy panels
if [[ -n "$CLAWDCURSOR_SIGN_IDENTITY" ]]; then
    echo "🔐 Signing with Developer ID: $CLAWDCURSOR_SIGN_IDENTITY"
    codesign --sign "$CLAWDCURSOR_SIGN_IDENTITY" \
        --options runtime \
        --entitlements entitlements.plist \
        --force \
        --deep \
        "ClawdCursor.app"
    echo "✅ Signed with Developer ID"
else
    # Ad-hoc sign by default — CRITICAL for TCC to recognize the app
    echo "🔐 Ad-hoc signing (required for TCC permissions)..."
    if [ -f "entitlements.plist" ]; then
        codesign --sign - \
            --options runtime \
            --entitlements entitlements.plist \
            --force \
            --deep \
            "ClawdCursor.app"
    else
        codesign --sign - \
            --force \
            --deep \
            "ClawdCursor.app"
    fi
    echo "✅ Ad-hoc signed"
fi

# Verify signature
if codesign -v "ClawdCursor.app" 2>/dev/null; then
    echo "✅ Signature verified"
else
    echo "⚠️  Signature verification failed — TCC permissions may not work"
    echo "   On macOS 26+ (Tahoe), unsigned binaries don't appear in privacy settings"
fi

echo ""
echo "📦 Output: $SCRIPT_DIR/ClawdCursor.app"
echo ""
echo "To test permissions:"
echo "  ./ClawdCursor.app/Contents/MacOS/permission-check"
echo ""
echo "To launch:"
echo "  open ClawdCursor.app"
