#!/usr/bin/env bash
#
# Build the Markus Desktop App from source (macOS).
#
# Steps:
#   1. Install dependencies (pnpm install)
#   2. Build all packages (shared, core, org-manager, cli, web-ui, etc.)
#   3. Build Chrome extension zip
#   4. Bundle Electron main process (esbuild → dist/main.js)
#   5. Package into .app via electron-builder (unsigned for local dev)
#   6. Optionally open the app
#
# Usage:
#   ./scripts/build-desktop.sh          # build + package
#   ./scripts/build-desktop.sh --open   # build + package + open
#   ./scripts/build-desktop.sh --dmg    # build + create signed .dmg
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OPEN_APP=false
BUILD_DMG=false

for arg in "$@"; do
  case "$arg" in
    --open) OPEN_APP=true ;;
    --dmg)  BUILD_DMG=true ;;
  esac
done

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { printf "\n${BOLD}${CYAN}▸ %s${NC}\n" "$1"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }

# ── 1. Install dependencies ──────────────────────────────────────────────────
step "Installing dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
ok "Dependencies installed"

# ── 2. Build all packages ────────────────────────────────────────────────────
step "Building all packages"
pnpm -r build
ok "All packages built"

# ── 3. Build Chrome extension ────────────────────────────────────────────────
step "Building Chrome extension"
pnpm --filter @markus/chrome-extension run pack
ok "Chrome extension packed"

# ── 4. Bundle Electron app ───────────────────────────────────────────────────
step "Bundling Electron main process"
cd "$ROOT/packages/desktop"
node build.mjs
ok "Electron bundle ready (dist/main.js + dist/preload.js)"

# ── 5. Package with electron-builder ─────────────────────────────────────────
if [ "$BUILD_DMG" = true ]; then
  step "Creating signed .dmg"
  npx electron-builder --mac dmg
  ok "DMG created"
else
  step "Packaging .app (unsigned, local dev)"
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --dir
  ok "App packaged"
fi

# ── Locate output ────────────────────────────────────────────────────────────
ARCH=$(uname -m)
case "$ARCH" in
  arm64) ARCH_DIR="mac-arm64" ;;
  x86_64) ARCH_DIR="mac-x64" ;;
  *) ARCH_DIR="mac" ;;
esac

APP_PATH="$ROOT/packages/desktop/dist-electron/$ARCH_DIR/Markus.app"

if [ -d "$APP_PATH" ]; then
  printf "\n${BOLD}${GREEN}✅ Build complete!${NC}\n"
  printf "   ${BOLD}%s${NC}\n\n" "$APP_PATH"
else
  DMG_PATH=$(ls "$ROOT/packages/desktop/dist-electron/"*.dmg 2>/dev/null | head -1)
  if [ -n "$DMG_PATH" ]; then
    printf "\n${BOLD}${GREEN}✅ Build complete!${NC}\n"
    printf "   ${BOLD}%s${NC}\n\n" "$DMG_PATH"
  fi
fi

# ── 6. Optionally open ──────────────────────────────────────────────────────
if [ "$OPEN_APP" = true ] && [ -d "$APP_PATH" ]; then
  step "Opening Markus.app"
  open "$APP_PATH"
fi
