#!/usr/bin/env bash
#
# Build a standalone Markus server binary for Linux.
#
# Output:
#   markus-v{VER}-linux-{ARCH}.tar.gz  (portable archive for install.sh)
#   markus-v{VER}-linux-{ARCH}.deb     (double-click installer)
#   markus-setup-linux-{ARCH}.deb      (fixed-name alias)
#
# Usage:
#   ./scripts/build-binary.sh linux <arch>
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'; BOLD='\033[1m'

die()  { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$*"; }
info() { printf "${BLUE}→${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ── Args ──────────────────────────────────────────────────────────────────────
PLATFORM="${1:-}"
ARCH="${2:-}"
[[ -z "$PLATFORM" || -z "$ARCH" ]] && die "Usage: $0 <platform> <arch>"

VERSION="$(node -p "require('./package.json').version")"
NODE_VERSION="$(node -v | sed 's/^v//')"

[[ "$PLATFORM" == "linux" ]] || die "Only linux is supported. macOS/Windows users should use the Desktop App or npm."
case "$ARCH" in
  x64|arm64) ;;
  *) die "Invalid arch: $ARCH" ;;
esac

ARCHIVE_NAME="markus-v${VERSION}-linux-${ARCH}"
STAGE_DIR="$ROOT_DIR/dist-binary/${ARCHIVE_NAME}"
OUT_DIR="$ROOT_DIR/dist-binary"
mkdir -p "$OUT_DIR"

info "${BOLD}Building ${ARCHIVE_NAME}${NC}"
info "Markus v${VERSION} / Node.js v${NODE_VERSION} / linux-${ARCH}"

# ── Step 1: Build the bundled CLI (if not already built) ──────────────────────
CLI_BUNDLE="$ROOT_DIR/packages/cli/dist/markus.mjs"
if [[ ! -f "$CLI_BUNDLE" ]]; then
  info "Building CLI bundle..."
  pnpm build
  pnpm --filter @markus/web-ui build
  pnpm --filter @markus-global/cli build:bundle
fi
[[ -f "$CLI_BUNDLE" ]] || die "CLI bundle not found at $CLI_BUNDLE"

# ── Step 2: Download Node.js binary ──────────────────────────────────────────
NODE_CACHE_DIR="$ROOT_DIR/dist-binary/.node-cache"
mkdir -p "$NODE_CACHE_DIR"

NODE_DIST_NAME="node-v${NODE_VERSION}-linux-${ARCH}"
NODE_ARCHIVE="${NODE_DIST_NAME}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
NODE_CACHED="$NODE_CACHE_DIR/$NODE_ARCHIVE"

if [[ -f "$NODE_CACHED" ]]; then
  info "Using cached Node.js: $NODE_ARCHIVE"
else
  info "Downloading Node.js v${NODE_VERSION} for linux-${ARCH}..."
  curl -fSL --progress-bar -o "$NODE_CACHED" "$NODE_URL" \
    || die "Failed to download $NODE_URL"
  ok "Downloaded $NODE_ARCHIVE"
fi

# ── Step 3: Assemble the staging directory ───────────────────────────────────
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/bin"

info "Extracting Node.js binary..."
TMPEXT="$NODE_CACHE_DIR/_extract_$$"
rm -rf "$TMPEXT"
mkdir -p "$TMPEXT"
tar -xzf "$NODE_CACHED" -C "$TMPEXT"
cp "$TMPEXT/${NODE_DIST_NAME}/bin/node" "$STAGE_DIR/bin/Markus"
chmod +x "$STAGE_DIR/bin/Markus"
ln -sf Markus "$STAGE_DIR/bin/node"
rm -rf "$TMPEXT"
ok "Node.js binary extracted"

cp "$CLI_BUNDLE" "$STAGE_DIR/bin/markus.mjs"

# Install native/external dependencies that esbuild cannot bundle
info "Installing native dependencies into staging dir..."
cat > "$STAGE_DIR/bin/package.json" << 'PKGJSON'
{ "private": true, "type": "module" }
PKGJSON
(cd "$STAGE_DIR/bin" && npm install --no-save ws sharp rfb2 node-datachannel@0.12.0 2>&1) \
  || die "Failed to install native dependencies"
rm -f "$STAGE_DIR/bin/package.json" "$STAGE_DIR/bin/package-lock.json"
ok "Native dependencies installed"

# Version marker so the bundled CLI can detect its own version
printf '{"name":"markus","version":"%s"}\n' "$VERSION" > "$STAGE_DIR/package.json"

WEB_UI_DIR="$ROOT_DIR/packages/cli/dist/web-ui"
[[ -d "$WEB_UI_DIR" ]] && cp -r "$WEB_UI_DIR" "$STAGE_DIR/web-ui" && ok "Web UI copied"

TEMPLATES_DIR="$ROOT_DIR/packages/cli/templates"
[[ -d "$TEMPLATES_DIR" ]] && cp -r "$TEMPLATES_DIR" "$STAGE_DIR/templates" && ok "Templates copied"

LOGO_PNG="$ROOT_DIR/packages/web-ui/public/logo.png"
[[ -f "$LOGO_PNG" ]] && cp "$LOGO_PNG" "$STAGE_DIR/logo.png" && ok "Logo copied"

# Chrome extension zip (for browser automation setup)
EXT_ZIP="$ROOT_DIR/packages/chrome-extension/dist/markus-browser-extension.zip"
if [[ ! -f "$EXT_ZIP" ]]; then
  info "Building Chrome extension zip..."
  (cd "$ROOT_DIR/packages/chrome-extension" && npm run pack --silent 2>/dev/null) || true
fi
if [[ -f "$EXT_ZIP" ]]; then
  mkdir -p "$STAGE_DIR/chrome-extension"
  cp "$EXT_ZIP" "$STAGE_DIR/chrome-extension/"
  ok "Chrome extension zip copied"
fi

# Create launcher wrapper
cat > "$STAGE_DIR/markus" << 'LAUNCHER'
#!/usr/bin/env bash
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
exec "$DIR/bin/node" "$DIR/bin/markus.mjs" "$@"
LAUNCHER
chmod +x "$STAGE_DIR/markus"
ok "Launcher created"

# ── Step 4: Create .deb installer ────────────────────────────────────────────

DEB_VERSIONED="${ARCHIVE_NAME}.deb"
DEB_FIXED="markus-setup-linux-${ARCH}.deb"
DEB_ROOT="$OUT_DIR/_deb_$$"
rm -rf "$DEB_ROOT"

INSTALL_PREFIX="$DEB_ROOT/usr/local/lib/markus"
mkdir -p "$INSTALL_PREFIX"
cp -r "$STAGE_DIR"/* "$INSTALL_PREFIX/"

mkdir -p "$DEB_ROOT/usr/local/bin"

mkdir -p "$DEB_ROOT/DEBIAN"
cat > "$DEB_ROOT/DEBIAN/control" << CONTROL
Package: markus
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: $([ "$ARCH" = "x64" ] && echo "amd64" || echo "arm64")
Maintainer: Markus Global <hello@markus.global>
Description: Markus — AI Digital Workforce Platform
 Deploy autonomous AI teams that work around the clock.
 Includes bundled Node.js runtime — no prerequisites needed.
CONTROL

cat > "$DEB_ROOT/DEBIAN/postinst" << 'POSTINST'
#!/bin/bash
set -e
ln -sf /usr/local/lib/markus/markus /usr/local/bin/markus

# Desktop shortcut
REAL_HOME=$(eval echo ~"$SUDO_USER")
DESKTOP_DIR="${XDG_DESKTOP_DIR:-$REAL_HOME/Desktop}"
if [ -d "$DESKTOP_DIR" ]; then
  cat > "$DESKTOP_DIR/markus.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Markus
Comment=AI Digital Workforce Platform
Exec=/usr/local/bin/markus start
Icon=/usr/local/lib/markus/logo.png
Terminal=false
Categories=Development;
StartupNotify=true
EOF
  chmod +x "$DESKTOP_DIR/markus.desktop"
  chown "$SUDO_USER" "$DESKTOP_DIR/markus.desktop" 2>/dev/null || true
fi

# Auto-start
AUTOSTART_DIR="$REAL_HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
cat > "$AUTOSTART_DIR/markus.desktop" << EOF
[Desktop Entry]
Type=Application
Name=Markus
Exec=/usr/local/bin/markus start
Icon=/usr/local/lib/markus/logo.png
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
chown "$SUDO_USER" "$AUTOSTART_DIR/markus.desktop" 2>/dev/null || true

exit 0
POSTINST
chmod +x "$DEB_ROOT/DEBIAN/postinst"

cat > "$DEB_ROOT/DEBIAN/prerm" << 'PRERM'
#!/bin/bash
set -e
rm -f /usr/local/bin/markus
REAL_HOME=$(eval echo ~"$SUDO_USER")
rm -f "$REAL_HOME/Desktop/markus.desktop"
rm -f "$REAL_HOME/.config/autostart/markus.desktop"
exit 0
PRERM
chmod +x "$DEB_ROOT/DEBIAN/prerm"

info "Building Linux .deb package..."
dpkg-deb --build --root-owner-group "$DEB_ROOT" "$OUT_DIR/$DEB_VERSIONED"
cp "$OUT_DIR/$DEB_VERSIONED" "$OUT_DIR/$DEB_FIXED"
rm -rf "$DEB_ROOT"
ok "Linux installer: $DEB_VERSIONED"

# ── Step 5: Create portable .tar.gz archive ──────────────────────────────────

info "Creating portable .tar.gz archive..."
tar -czf "$OUT_DIR/${ARCHIVE_NAME}.tar.gz" -C "$OUT_DIR" "$(basename "$STAGE_DIR")"
ok "Portable archive: ${ARCHIVE_NAME}.tar.gz"

# ── Summary ──────────────────────────────────────────────────────────────────
printf "\n"
info "Output files in dist-binary/:"
ls -lh "$OUT_DIR"/markus-*"linux-${ARCH}"* 2>/dev/null || true
printf "\n${GREEN}${BOLD}  Done!${NC}\n\n"
