#!/usr/bin/env bash
#
# Build a standalone Markus binary archive for a given platform/arch.
#
# The archive bundles the Node.js runtime so end-users need zero prerequisites.
#
# Usage:
#   ./scripts/build-binary.sh <platform> <arch>
#
# Platforms: linux, darwin, win
# Arches:   x64, arm64
#
# Examples:
#   ./scripts/build-binary.sh darwin arm64
#   ./scripts/build-binary.sh win x64
#   ./scripts/build-binary.sh linux x64
#
# Output: dist-binary/markus-v{VERSION}-{PLATFORM}-{ARCH}.{tar.gz|zip}
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'; BOLD='\033[1m'

die()  { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }
info() { printf "${BLUE}→${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ── Args ──────────────────────────────────────────────────────────────────────
PLATFORM="${1:-}"
ARCH="${2:-}"
[[ -z "$PLATFORM" || -z "$ARCH" ]] && die "Usage: $0 <platform> <arch>  (e.g. darwin arm64, win x64, linux x64)"

VERSION="$(node -p "require('./package.json').version")"
NODE_VERSION="$(node -v | sed 's/^v//')"

# ── Validate ──────────────────────────────────────────────────────────────────
case "$PLATFORM" in
  linux|darwin|win) ;;
  *) die "Invalid platform: $PLATFORM (expected: linux, darwin, win)" ;;
esac
case "$ARCH" in
  x64|arm64) ;;
  *) die "Invalid arch: $ARCH (expected: x64, arm64)" ;;
esac

ARCHIVE_NAME="markus-v${VERSION}-${PLATFORM}-${ARCH}"
STAGE_DIR="$ROOT_DIR/dist-binary/${ARCHIVE_NAME}"
OUT_DIR="$ROOT_DIR/dist-binary"

info "${BOLD}Building ${ARCHIVE_NAME}${NC}"
info "Markus v${VERSION} / Node.js v${NODE_VERSION} / ${PLATFORM}-${ARCH}"

# ── Step 1: Build the bundled CLI (if not already built) ──────────────────────
CLI_BUNDLE="$ROOT_DIR/packages/cli/dist/markus.mjs"
if [[ ! -f "$CLI_BUNDLE" ]]; then
  info "Building CLI bundle..."
  pnpm build
  pnpm --filter @markus/web-ui build
  pnpm --filter @markus-global/cli build:bundle
fi

[[ -f "$CLI_BUNDLE" ]] || die "CLI bundle not found at $CLI_BUNDLE — run 'pnpm run build:publish' first"

# ── Step 2: Download Node.js binary ──────────────────────────────────────────
NODE_CACHE_DIR="$ROOT_DIR/dist-binary/.node-cache"
mkdir -p "$NODE_CACHE_DIR"

# Map our platform names to Node.js dist names
case "$PLATFORM" in
  win)    NODE_OS="win";    NODE_EXT="zip" ;;
  darwin) NODE_OS="darwin"; NODE_EXT="tar.gz" ;;
  linux)  NODE_OS="linux";  NODE_EXT="tar.gz" ;;
esac

NODE_DIST_NAME="node-v${NODE_VERSION}-${NODE_OS}-${ARCH}"
NODE_ARCHIVE="${NODE_DIST_NAME}.${NODE_EXT}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
NODE_CACHED="$NODE_CACHE_DIR/$NODE_ARCHIVE"

if [[ -f "$NODE_CACHED" ]]; then
  info "Using cached Node.js: $NODE_ARCHIVE"
else
  info "Downloading Node.js v${NODE_VERSION} for ${PLATFORM}-${ARCH}..."
  curl -fSL --progress-bar -o "$NODE_CACHED" "$NODE_URL" \
    || die "Failed to download $NODE_URL"
  ok "Downloaded $NODE_ARCHIVE"
fi

# ── Step 3: Assemble the package ─────────────────────────────────────────────
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/bin"

# Extract the node binary from the downloaded archive
info "Extracting Node.js binary..."
TMPEXT="$NODE_CACHE_DIR/_extract_$$"
rm -rf "$TMPEXT"
mkdir -p "$TMPEXT"

if [[ "$NODE_EXT" == "zip" ]]; then
  unzip -q "$NODE_CACHED" -d "$TMPEXT"
  cp "$TMPEXT/${NODE_DIST_NAME}/node.exe" "$STAGE_DIR/bin/node.exe"
else
  tar -xzf "$NODE_CACHED" -C "$TMPEXT"
  cp "$TMPEXT/${NODE_DIST_NAME}/bin/node" "$STAGE_DIR/bin/node"
  chmod +x "$STAGE_DIR/bin/node"
fi
rm -rf "$TMPEXT"
ok "Node.js binary extracted"

# Copy bundled CLI
cp "$CLI_BUNDLE" "$STAGE_DIR/bin/markus.mjs"

# Copy Web UI static assets
WEB_UI_DIR="$ROOT_DIR/packages/cli/dist/web-ui"
if [[ -d "$WEB_UI_DIR" ]]; then
  cp -r "$WEB_UI_DIR" "$STAGE_DIR/web-ui"
  ok "Web UI assets copied"
else
  printf "${YELLOW}!${NC} Web UI not found at $WEB_UI_DIR — skipping\n"
fi

# Copy templates
TEMPLATES_DIR="$ROOT_DIR/packages/cli/templates"
if [[ -d "$TEMPLATES_DIR" ]]; then
  cp -r "$TEMPLATES_DIR" "$STAGE_DIR/templates"
  ok "Templates copied"
else
  printf "${YELLOW}!${NC} Templates not found at $TEMPLATES_DIR — skipping\n"
fi

# ── Step 4: Create launcher wrappers ─────────────────────────────────────────
if [[ "$PLATFORM" == "win" ]]; then
  cat > "$STAGE_DIR/markus.cmd" << 'LAUNCHER'
@echo off
"%~dp0\bin\node.exe" "%~dp0\bin\markus.mjs" %*
LAUNCHER
  ok "Created markus.cmd launcher"
else
  cat > "$STAGE_DIR/markus" << 'LAUNCHER'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/bin/node" "$DIR/bin/markus.mjs" "$@"
LAUNCHER
  chmod +x "$STAGE_DIR/markus"
  ok "Created markus launcher"
fi

# ── Step 5: Create archive ───────────────────────────────────────────────────
info "Creating archive..."
cd "$OUT_DIR"

if [[ "$PLATFORM" == "win" ]]; then
  ARCHIVE_FILE="${ARCHIVE_NAME}.zip"
  if command -v zip &>/dev/null; then
    zip -qr "$ARCHIVE_FILE" "$ARCHIVE_NAME"
  else
    # Fallback for CI environments without zip
    7z a -tzip "$ARCHIVE_FILE" "$ARCHIVE_NAME" > /dev/null 2>&1 \
      || tar -czf "${ARCHIVE_NAME}.tar.gz" "$ARCHIVE_NAME"
  fi
else
  ARCHIVE_FILE="${ARCHIVE_NAME}.tar.gz"
  tar -czf "$ARCHIVE_FILE" "$ARCHIVE_NAME"
fi

ARCHIVE_SIZE="$(du -sh "$ARCHIVE_FILE" | cut -f1)"

cd "$ROOT_DIR"
ok "Archive created: dist-binary/${ARCHIVE_FILE} (${ARCHIVE_SIZE})"

printf "\n${GREEN}${BOLD}  Done!${NC} ${ARCHIVE_NAME} is ready for distribution.\n\n"
