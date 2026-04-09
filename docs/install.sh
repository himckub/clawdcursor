#!/bin/bash
# Clawd Cursor Installer for macOS / Linux
# Usage: curl -fsSL https://clawdcursor.com/install.sh | bash
# Specify version: VERSION=v0.7.11 curl -fsSL https://clawdcursor.com/install.sh | bash

set -e

VERSION="${VERSION:-main}"
INSTALL_DIR="$HOME/clawdcursor"

echo ""
echo "  /\___/\\"
echo " ( >^.^< )  Clawd Cursor Installer"
echo "  )     ("
echo " (_)_(_)_)"
echo ""

# ── 1. Check Node.js ─────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
    echo "  ❌ Node.js not found. Install v20+ from https://nodejs.org"
    exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "  ❌ Node.js $(node --version) is too old. Update to v20+: https://nodejs.org"
    exit 1
fi
echo "  ✅ Node.js $(node --version)"

# ── 2. Check git ──────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
    echo "  ❌ git not found. Install: brew install git (macOS) or sudo apt install git (Linux)"
    exit 1
fi
echo "  ✅ $(git --version)"

# ── 3. Clone or update ───────────────────────────────────────────────────────
echo ""
DISPLAY_VERSION="$VERSION"
[ "$VERSION" = "main" ] && DISPLAY_VERSION="latest (main)"

if [ -d "$INSTALL_DIR/.git" ]; then
    # Update existing install
    echo "  📦 Updating to $DISPLAY_VERSION..."
    cd "$INSTALL_DIR"
    git fetch --all --tags --quiet 2>/dev/null
    git checkout "$VERSION" --quiet 2>/dev/null && git pull --quiet 2>/dev/null || {
        echo "  ⚠️  Update failed, doing fresh install..."
        cd "$HOME"
        rm -rf "$INSTALL_DIR"
        git clone https://github.com/AmrDab/clawdcursor.git --branch "$VERSION" "$INSTALL_DIR" --quiet
    }
elif [ -d "$INSTALL_DIR" ]; then
    # Corrupted — no .git, remove and reclone
    rm -rf "$INSTALL_DIR"
    echo "  📦 Downloading $DISPLAY_VERSION..."
    git clone https://github.com/AmrDab/clawdcursor.git --branch "$VERSION" "$INSTALL_DIR" --quiet
else
    echo "  📦 Downloading $DISPLAY_VERSION..."
    git clone https://github.com/AmrDab/clawdcursor.git --branch "$VERSION" "$INSTALL_DIR" --quiet
fi

# ── 4. Install dependencies ──────────────────────────────────────────────────
echo "  📦 Installing dependencies..."
cd "$INSTALL_DIR"
npm install --loglevel error 2>/dev/null

# ── 5. Build ──────────────────────────────────────────────────────────────────
echo "  🔨 Building..."
npm run build 2>/dev/null

# ── 5b. Build native macOS host app (REQUIRED on macOS) ──────────────────────
if [ "$(uname)" = "Darwin" ]; then
    NATIVE_HOST="$INSTALL_DIR/native/ClawdCursor.app/Contents/MacOS/ClawdCursorHost"
    
    if ! command -v swift &>/dev/null; then
        echo ""
        echo "  ❌ Swift not found — REQUIRED for macOS"
        echo ""
        echo "     Install Xcode Command Line Tools:"
        echo "       xcode-select --install"
        echo ""
        echo "     Then re-run the installer."
        exit 1
    fi
    
    echo "  🔨 Building macOS native host app..."
    cd "$INSTALL_DIR/native"
    
    # Show build output so errors are visible
    if ./build.sh 2>&1 | while read line; do echo "     $line"; done; then
        # Verify the binary actually exists
        if [ -f "$NATIVE_HOST" ]; then
            echo "  ✅ Native host app built"
        else
            echo ""
            echo "  ❌ Build appeared to succeed but ClawdCursorHost binary not found"
            echo "     Expected: $NATIVE_HOST"
            echo ""
            echo "     Try building manually:"
            echo "       cd $INSTALL_DIR/native && ./build.sh"
            exit 1
        fi
    else
        echo ""
        echo "  ❌ Native host app build FAILED"
        echo ""
        echo "     This is REQUIRED for macOS. Common fixes:"
        echo "       • Install Xcode Command Line Tools: xcode-select --install"
        echo "       • Update Swift: softwareupdate --install -a"
        echo "       • Check build errors above"
        echo ""
        echo "     Manual build:"
        echo "       cd $INSTALL_DIR/native && ./build.sh"
        exit 1
    fi
    cd "$INSTALL_DIR"
fi

# ── 6. Link ───────────────────────────────────────────────────────────────────
echo "  🔗 Linking..."
npm link --force 2>/dev/null || true

# ── 7. Verify ─────────────────────────────────────────────────────────────────
echo ""

# Final macOS verification: ensure native host binary exists
if [ "$(uname)" = "Darwin" ]; then
    NATIVE_HOST="$INSTALL_DIR/native/ClawdCursor.app/Contents/MacOS/ClawdCursorHost"
    if [ ! -f "$NATIVE_HOST" ]; then
        echo "  ❌ INSTALLATION INCOMPLETE"
        echo ""
        echo "     The macOS native host app (ClawdCursorHost) is missing."
        echo "     This is required for clawdcursor to work on macOS."
        echo ""
        echo "     Try rebuilding manually:"
        echo "       cd $INSTALL_DIR/native && ./build.sh"
        echo ""
        exit 1
    fi
fi

if command -v clawdcursor &>/dev/null; then
    echo "  ✅ Clawd Cursor $(clawdcursor --version 2>/dev/null || echo $VERSION) installed!"
else
    NPM_PREFIX="$(npm prefix -g 2>/dev/null)/bin"
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$NPM_PREFIX"; then
        echo "  ✅ Installed, but npm's bin folder is not in your PATH."
        echo "     Add this to your shell profile (~/.bashrc or ~/.zshrc):"
        echo "       export PATH=\"$NPM_PREFIX:\$PATH\""
    else
        echo "  ✅ Installed! Reopen your terminal to use 'clawdcursor'."
    fi
fi

echo ""
echo "  ┌────────────────────────────────────────────────────────────┐"
echo "  │  Next steps:                                               │"
echo "  ├────────────────────────────────────────────────────────────┤"
echo "  │  1. clawdcursor doctor    Set up API keys & check perms   │"
echo "  │  2. clawdcursor start     Launch the agent                │"
echo "  └────────────────────────────────────────────────────────────┘"
echo ""
echo "  Run now:"
echo "    clawdcursor doctor"
echo ""
