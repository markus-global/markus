#!/usr/bin/env bash
#
# Build a standalone Markus installer for a given platform/arch.
#
# Output per platform (double-click to install):
#   macOS:   markus-v{VER}-darwin-{ARCH}.pkg   + fixed-name markus-setup-darwin-{ARCH}.pkg
#   Windows: markus-v{VER}-win-x64.exe         + fixed-name markus-setup-win-x64.exe
#   Linux:   markus-v{VER}-linux-x64.deb       + fixed-name markus-setup-linux-x64.deb
#
# Usage:
#   ./scripts/build-binary.sh <platform> <arch>
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

case "$PLATFORM" in
  linux|darwin|win) ;;
  *) die "Invalid platform: $PLATFORM" ;;
esac
case "$ARCH" in
  x64|arm64) ;;
  *) die "Invalid arch: $ARCH" ;;
esac

ARCHIVE_NAME="markus-v${VERSION}-${PLATFORM}-${ARCH}"
STAGE_DIR="$ROOT_DIR/dist-binary/${ARCHIVE_NAME}"
OUT_DIR="$ROOT_DIR/dist-binary"
mkdir -p "$OUT_DIR"

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
[[ -f "$CLI_BUNDLE" ]] || die "CLI bundle not found at $CLI_BUNDLE"

# ── Step 2: Download Node.js binary ──────────────────────────────────────────
NODE_CACHE_DIR="$ROOT_DIR/dist-binary/.node-cache"
mkdir -p "$NODE_CACHE_DIR"

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

# ── Step 3: Assemble the staging directory ───────────────────────────────────
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/bin"

info "Extracting Node.js binary..."
TMPEXT="$NODE_CACHE_DIR/_extract_$$"
rm -rf "$TMPEXT"
mkdir -p "$TMPEXT"

if [[ "$NODE_EXT" == "zip" ]]; then
  unzip -q "$NODE_CACHED" -d "$TMPEXT"
  cp "$TMPEXT/${NODE_DIST_NAME}/node.exe" "$STAGE_DIR/bin/node.exe"
else
  tar -xzf "$NODE_CACHED" -C "$TMPEXT"
  cp "$TMPEXT/${NODE_DIST_NAME}/bin/node" "$STAGE_DIR/bin/Markus"
  chmod +x "$STAGE_DIR/bin/Markus"
  ln -sf Markus "$STAGE_DIR/bin/node"
fi
rm -rf "$TMPEXT"
ok "Node.js binary extracted"

cp "$CLI_BUNDLE" "$STAGE_DIR/bin/markus.mjs"

# Copy tray controller
TRAY_BUNDLE="$ROOT_DIR/packages/cli/dist/tray.mjs"
if [[ -f "$TRAY_BUNDLE" ]]; then
  cp "$TRAY_BUNDLE" "$STAGE_DIR/bin/tray.mjs"
  ok "Tray controller copied"
else
  warn "tray.mjs not found — desktop tray will not be available"
fi

# Install native/external dependencies that esbuild cannot bundle
info "Installing native dependencies into staging dir..."
cat > "$STAGE_DIR/bin/package.json" << 'PKGJSON'
{ "private": true, "type": "module" }
PKGJSON
(cd "$STAGE_DIR/bin" && npm install --no-save ws sharp rfb2 systray2 node-datachannel 2>&1) \
  || die "Failed to install native dependencies"
rm -f "$STAGE_DIR/bin/package.json" "$STAGE_DIR/bin/package-lock.json"

# Ensure systray2 tray binaries have execute permission (npm install doesn't always set +x)
find "$STAGE_DIR/bin/node_modules/systray2/traybin" -type f 2>/dev/null | while read -r tb; do
  chmod +x "$tb"
done

# Verify systray2 tray binary exists for the target platform
if [[ "$PLATFORM" == "win" ]]; then
  TRAY_BIN="$STAGE_DIR/bin/node_modules/systray2/traybin/tray_windows_release.exe"
elif [[ "$PLATFORM" == "darwin" ]]; then
  TRAY_BIN="$STAGE_DIR/bin/node_modules/systray2/traybin/tray_darwin_release"
else
  TRAY_BIN="$STAGE_DIR/bin/node_modules/systray2/traybin/tray_linux_release"
fi
if [[ -f "$TRAY_BIN" ]]; then
  ok "Native dependencies installed (tray binary: $(basename "$TRAY_BIN"))"
else
  warn "systray2 tray binary not found at $TRAY_BIN — tray icon will be unavailable"
  ok "Native dependencies installed (without tray binary)"
fi

# Version marker so the bundled CLI can detect its own version
# (version.ts looks for ../package.json relative to bin/markus.mjs)
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

# Create launcher wrappers
if [[ "$PLATFORM" == "win" ]]; then
  cat > "$STAGE_DIR/markus.cmd" << 'LAUNCHER'
@echo off
"%~dp0\bin\node.exe" "%~dp0\bin\markus.mjs" %*
LAUNCHER

  # VBS launcher to run tray.mjs without a console window (wscript hides it)
  cat > "$STAGE_DIR/markus-tray.vbs" << 'VBS'
On Error Resume Next

Set fso = CreateObject("Scripting.FileSystemObject")
Set wshShell = CreateObject("WScript.Shell")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = fso.BuildPath(appDir, "bin\node.exe")
trayMjs = fso.BuildPath(appDir, "bin\tray.mjs")
logDir = fso.BuildPath(wshShell.ExpandEnvironmentStrings("%USERPROFILE%"), ".markus\logs")
logFile = fso.BuildPath(logDir, "tray-vbs.log")

Sub WriteLog(msg)
    On Error Resume Next
    If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
    Set f = fso.OpenTextFile(logFile, 8, True)
    f.WriteLine Now() & " " & msg
    f.Close
End Sub

If Not fso.FileExists(nodeExe) Then
    WriteLog "ERROR: node.exe not found at " & nodeExe
    MsgBox "Markus cannot start: node.exe not found." & vbCrLf & vbCrLf & nodeExe, vbCritical, "Markus"
    WScript.Quit 1
End If

If Not fso.FileExists(trayMjs) Then
    WriteLog "ERROR: tray.mjs not found at " & trayMjs
    MsgBox "Markus cannot start: tray.mjs not found." & vbCrLf & vbCrLf & trayMjs, vbCritical, "Markus"
    WScript.Quit 1
End If

WriteLog "Launching: " & nodeExe & " " & trayMjs
cmdLine = """" & nodeExe & """ """ & trayMjs & """"
exitCode = wshShell.Run(cmdLine, 0, False)

If Err.Number <> 0 Then
    WriteLog "ERROR: Run failed: " & Err.Description
    MsgBox "Markus failed to start:" & vbCrLf & Err.Description, vbCritical, "Markus"
    WScript.Quit 1
End If

WriteLog "Process launched successfully"
VBS
  ok "VBS tray launcher created"
else
  cat > "$STAGE_DIR/markus" << 'LAUNCHER'
#!/usr/bin/env bash
# Resolve symlinks to find the real install directory
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
fi
ok "Launcher created"

# ── Step 4: Create platform-specific installer ───────────────────────────────

if [[ "$PLATFORM" == "darwin" ]]; then
  # ── macOS: .pkg installer ──────────────────────────────────────────────
  INSTALL_LOCATION="/usr/local/lib/markus"
  PKG_ID="global.markus.cli"
  PKG_VERSIONED="${ARCHIVE_NAME}.pkg"
  PKG_FIXED="markus-setup-darwin-${ARCH}.pkg"

  # Generate .icns from logo.png (Apple iconset spec: 16/32/128/256/512 + @2x variants)
  if [[ -f "$STAGE_DIR/logo.png" ]]; then
    ICONSET_DIR="$OUT_DIR/_markus_iconset_$$.iconset"
    mkdir -p "$ICONSET_DIR"
    # 1x sizes
    for size in 16 32 128 256 512; do
      sips -z $size $size "$STAGE_DIR/logo.png" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null 2>&1
    done
    # @2x sizes (32, 64, 256, 512, 1024)
    sips -z 32   32   "$STAGE_DIR/logo.png" --out "$ICONSET_DIR/icon_16x16@2x.png"   >/dev/null 2>&1
    sips -z 64   64   "$STAGE_DIR/logo.png" --out "$ICONSET_DIR/icon_32x32@2x.png"   >/dev/null 2>&1
    sips -z 256  256  "$STAGE_DIR/logo.png" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null 2>&1
    sips -z 512  512  "$STAGE_DIR/logo.png" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null 2>&1
    sips -z 1024 1024 "$STAGE_DIR/logo.png" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null 2>&1
    iconutil -c icns "$ICONSET_DIR" -o "$STAGE_DIR/markus.icns"
    rm -rf "$ICONSET_DIR"
    ok "Generated markus.icns"
  fi

  # Pre-install script: gracefully stop running Markus before upgrade
  SCRIPTS_DIR="$OUT_DIR/_pkg_scripts_$$"
  mkdir -p "$SCRIPTS_DIR"
  cat > "$SCRIPTS_DIR/preinstall" << 'PREINSTALL'
#!/bin/bash
# Gracefully stop any running Markus server before files are overwritten.
CONSOLE_USER=$(/usr/sbin/scutil <<< "show State:/Users/ConsoleUser" | awk '/Name :/ { print $3 }')
if [ -z "$CONSOLE_USER" ] || [ "$CONSOLE_USER" = "loginwindow" ]; then
  CONSOLE_USER=$(stat -f "%Su" /dev/console 2>/dev/null)
fi
CONSOLE_UID=$(id -u "$CONSOLE_USER" 2>/dev/null || echo "")

# Unload LaunchAgent first (prevents auto-restart while we're upgrading)
if [ -n "$CONSOLE_UID" ]; then
  launchctl bootout "gui/$CONSOLE_UID/global.markus" 2>/dev/null || true
fi

# Try graceful shutdown via CLI
if [ -x /usr/local/bin/markus ]; then
  sudo -u "$CONSOLE_USER" /usr/local/bin/markus stop 2>/dev/null || true
fi

# Wait up to 5 seconds for the server to stop
PORT=8056
for i in $(seq 1 10); do
  if ! lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Force kill if still running
PIDS=$(lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# Kill tray process if still running
pkill -f "tray.mjs" 2>/dev/null || true
pkill -f "tray_darwin_release" 2>/dev/null || true

exit 0
PREINSTALL
  chmod +x "$SCRIPTS_DIR/preinstall"

  # Post-install script: symlink + codesign + app bundle + launchd + auto-open
  cat > "$SCRIPTS_DIR/postinstall" << 'POSTINSTALL'
#!/bin/bash
INSTALL_DIR="/usr/local/lib/markus"
PORT=8056
ln -sf "$INSTALL_DIR/markus" /usr/local/bin/markus

# Detect the real console user (postinstall runs as root, so $USER == root)
CONSOLE_USER=$(/usr/sbin/scutil <<< "show State:/Users/ConsoleUser" | awk '/Name :/ { print $3 }')
if [ -z "$CONSOLE_USER" ] || [ "$CONSOLE_USER" = "loginwindow" ]; then
  CONSOLE_USER=$(stat -f "%Su" /dev/console 2>/dev/null)
fi
REAL_HOME=$(eval echo ~"$CONSOLE_USER")

# ── Re-codesign Node.js binary with JIT entitlements ──────────────────────
# macOS can strip ad-hoc signatures during .pkg extraction; re-sign to ensure
# V8 JIT works correctly (prevents "Check failed" / SIGKILL crashes).
ENTITLEMENTS_TMP=$(mktemp /tmp/markus-entitlements-XXXXXX.plist)
cat > "$ENTITLEMENTS_TMP" << 'ENTXML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
ENTXML

for bin_file in "$INSTALL_DIR/bin/Markus" "$INSTALL_DIR/bin/node_modules/systray2/traybin/tray_darwin_release"; do
  if [ -f "$bin_file" ]; then
    chmod +x "$bin_file"
    codesign --force --options runtime --entitlements "$ENTITLEMENTS_TMP" --sign - "$bin_file" 2>/dev/null || true
  fi
done
rm -f "$ENTITLEMENTS_TMP"

# ── Markus.app in /Applications ───────────────────────────────────────────
APP_DIR="/Applications/Markus.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

cat > "$APP_DIR/Contents/Info.plist" << PLIST_APP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Markus</string>
  <key>CFBundleDisplayName</key>
  <string>Markus</string>
  <key>CFBundleIdentifier</key>
  <string>global.markus.desktop</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>launch</string>
  <key>CFBundleIconFile</key>
  <string>markus</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST_APP

cat > "$APP_DIR/Contents/MacOS/launch" << 'LAUNCH_SCRIPT'
#!/bin/bash
MARKUS_DIR="/usr/local/lib/markus"
NODE="$MARKUS_DIR/bin/Markus"
LOG_DIR="$HOME/.markus/logs"
PORT=8056
mkdir -p "$LOG_DIR"

# Always launch the tray controller — it handles server start, existing server
# detection, port conflicts, browser open, and keeps the menu bar icon alive.
if [ -f "$MARKUS_DIR/bin/tray.mjs" ]; then
  exec "$NODE" "$MARKUS_DIR/bin/tray.mjs" 2>>"$LOG_DIR/tray-stderr.log"
fi

# Fallback if tray.mjs is missing: start server directly
if curl -s --max-time 2 -o /dev/null "http://localhost:$PORT/api/health" 2>/dev/null; then
  open "http://localhost:$PORT"
  exit 0
fi

"$NODE" "$MARKUS_DIR/bin/markus.mjs" start \
  >> "$LOG_DIR/stdout.log" 2>> "$LOG_DIR/stderr.log" &
SERVER_PID=$!

TRIES=0
while [ $TRIES -lt 60 ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    osascript -e 'display dialog "Markus failed to start.\nCheck logs at ~/.markus/logs/" with title "Markus" buttons {"OK"} default button "OK" with icon stop'
    exit 1
  fi
  if curl -s --max-time 2 -o /dev/null "http://localhost:$PORT/api/health" 2>/dev/null; then
    open "http://localhost:$PORT"
    break
  fi
  sleep 0.5
  TRIES=$((TRIES + 1))
done
wait "$SERVER_PID"
LAUNCH_SCRIPT
chmod +x "$APP_DIR/Contents/MacOS/launch"

if [ -f "$INSTALL_DIR/markus.icns" ]; then
  cp "$INSTALL_DIR/markus.icns" "$APP_DIR/Contents/Resources/markus.icns"
fi

# Remove legacy Desktop shortcut if present (only if it actually exists,
# to avoid triggering macOS TCC permission dialog for ~/Desktop access)
if [ -e "$REAL_HOME/Desktop/Markus.app" ]; then
  rm -rf "$REAL_HOME/Desktop/Markus.app"
fi

# ── Auto-start on login (launchd) ─────────────────────────────────────────
PLIST_DIR="$REAL_HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"
cat > "$PLIST_DIR/global.markus.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>global.markus</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/lib/markus/bin/Markus</string>
    <string>/usr/local/lib/markus/bin/markus.mjs</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NO_BROWSER</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${REAL_HOME}/.markus/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${REAL_HOME}/.markus/logs/stderr.log</string>
</dict>
</plist>
PLIST
chown "$CONSOLE_USER" "$PLIST_DIR/global.markus.plist"
mkdir -p "$REAL_HOME/.markus/logs"
chown -R "$CONSOLE_USER" "$REAL_HOME/.markus"

# The LaunchAgent plist is now in ~/Library/LaunchAgents/ with RunAtLoad=true.
# macOS automatically loads all plists in this directory on login, so we don't
# need to explicitly `bootstrap` or `load` it. The server will auto-start on
# next login. For immediate startup after install, we use open Markus.app below.

# ── Launch Markus.app immediately after install ───────────────────────────
# Open the .app bundle which handles server start + browser open + tray icon.
# Run in background so postinstall doesn't block the installer UI.
(
  sleep 2
  sudo -u "$CONSOLE_USER" open /Applications/Markus.app
) &

exit 0
POSTINSTALL
  chmod +x "$SCRIPTS_DIR/postinstall"

  # Entitlements required for Node.js V8 JIT engine on macOS
  ENTITLEMENTS="$OUT_DIR/_entitlements_$$.plist"
  cat > "$ENTITLEMENTS" << 'ENTPLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
ENTPLIST

  # Codesign all Mach-O binaries/dylibs (required for notarization + JIT on macOS)
  SIGN_ID="${MACOS_CODESIGN_IDENTITY:--}"
  if [[ "$SIGN_ID" == "-" ]]; then
    info "Ad-hoc codesigning binaries (JIT entitlements)..."
  else
    info "Codesigning binaries with: $SIGN_ID"
  fi
  find "$STAGE_DIR" -type f | while read -r f; do
    if file "$f" | grep -qE "Mach-O|bundle"; then
      SIGN_ARGS=(--force --options runtime --entitlements "$ENTITLEMENTS" --sign "$SIGN_ID")
      [[ "$SIGN_ID" != "-" ]] && SIGN_ARGS+=(--timestamp)
      codesign "${SIGN_ARGS[@]}" "$f" && \
        printf "  signed: %s\n" "$(basename "$f")" || \
        printf "  WARN: failed to sign %s\n" "$f" >&2
    fi
  done
  rm -f "$ENTITLEMENTS"
  ok "Codesigning complete"

  info "Building macOS .pkg installer..."
  pkgbuild \
    --root "$STAGE_DIR" \
    --identifier "$PKG_ID" \
    --version "$VERSION" \
    --install-location "$INSTALL_LOCATION" \
    --scripts "$SCRIPTS_DIR" \
    "$OUT_DIR/$PKG_VERSIONED"

  cp "$OUT_DIR/$PKG_VERSIONED" "$OUT_DIR/$PKG_FIXED"
  rm -rf "$SCRIPTS_DIR"
  ok "macOS installer: $PKG_VERSIONED"

elif [[ "$PLATFORM" == "linux" ]]; then
  # ── Linux: .deb package ────────────────────────────────────────────────
  DEB_VERSIONED="${ARCHIVE_NAME}.deb"
  DEB_FIXED="markus-setup-linux-${ARCH}.deb"
  DEB_ROOT="$OUT_DIR/_deb_$$"
  rm -rf "$DEB_ROOT"

  INSTALL_PREFIX="$DEB_ROOT/usr/local/lib/markus"
  mkdir -p "$INSTALL_PREFIX"
  cp -r "$STAGE_DIR"/* "$INSTALL_PREFIX/"

  mkdir -p "$DEB_ROOT/usr/local/bin"
  # Symlink created via postinst instead (dpkg doesn't like symlinks in the tree)

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
Exec=/usr/local/lib/markus/bin/node /usr/local/lib/markus/bin/tray.mjs
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
Exec=/usr/local/lib/markus/bin/node /usr/local/lib/markus/bin/tray.mjs
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
launchctl unload "$REAL_HOME/Library/LaunchAgents/global.markus.plist" 2>/dev/null || true
rm -f "$REAL_HOME/Library/LaunchAgents/global.markus.plist"
exit 0
PRERM
  chmod +x "$DEB_ROOT/DEBIAN/prerm"

  info "Building Linux .deb package..."
  dpkg-deb --build --root-owner-group "$DEB_ROOT" "$OUT_DIR/$DEB_VERSIONED"
  cp "$OUT_DIR/$DEB_VERSIONED" "$OUT_DIR/$DEB_FIXED"
  rm -rf "$DEB_ROOT"
  ok "Linux installer: $DEB_VERSIONED"

elif [[ "$PLATFORM" == "win" ]]; then
  # ── Windows: Inno Setup .exe installer ─────────────────────────────────
  EXE_VERSIONED="${ARCHIVE_NAME}-setup.exe"
  EXE_FIXED="markus-setup-win-${ARCH}.exe"

  # Generate .ico from logo.png using ImageMagick (pre-installed on GH Actions Windows runners)
  WIN_ICON_LINE="SetupIconFile=compiler:SetupClassicIcon.ico"
  WIN_ICON_REF=""
  if [[ -f "$STAGE_DIR/logo.png" ]] && command -v magick &>/dev/null; then
    magick "$STAGE_DIR/logo.png" -define icon:auto-resize=256,128,64,48,32,16 "$STAGE_DIR/markus.ico"
    WIN_ICON_ICO="$(cygpath -w "$STAGE_DIR/markus.ico" 2>/dev/null || echo "$STAGE_DIR/markus.ico")"
    WIN_ICON_LINE="SetupIconFile=${WIN_ICON_ICO}"
    WIN_ICON_REF="; IconFilename: \"{app}\\markus.ico\""
    ok "Generated markus.ico"
  fi

  # Convert Unix paths to Windows paths for Inno Setup
  WIN_OUT_DIR="$(cygpath -w "$OUT_DIR" 2>/dev/null || echo "$OUT_DIR")"
  WIN_STAGE_DIR="$(cygpath -w "$STAGE_DIR" 2>/dev/null || echo "$STAGE_DIR")"

  ISS_FILE="$OUT_DIR/_markus_setup_$$.iss"
  cat > "$ISS_FILE" << ISS
[Setup]
AppName=Markus
AppVersion=${VERSION}
AppPublisher=Markus Global
AppPublisherURL=https://markus.global
DefaultDirName={localappdata}\\markus
DefaultGroupName=Markus
OutputDir=${WIN_OUT_DIR}
OutputBaseFilename=${EXE_VERSIONED%.exe}
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
ChangesEnvironment=yes
${WIN_ICON_LINE}

[Files]
Source: "${WIN_STAGE_DIR}\\*"; DestDir: "{app}"; Flags: recursesubdirs

[Tasks]
Name: "autostart"; Description: "Start Markus automatically on login"; GroupDescription: "Additional options:"; Flags: checkedonce

[Icons]
Name: "{userdesktop}\\Markus"; Filename: "wscript.exe"; Parameters: """{app}\\markus-tray.vbs"""; WorkingDir: "{app}"; Comment: "Markus - AI Digital Workforce Platform"${WIN_ICON_REF}
Name: "{userstartup}\\Markus"; Filename: "wscript.exe"; Parameters: """{app}\\markus-tray.vbs"""; WorkingDir: "{app}"; Comment: "Markus auto-start"${WIN_ICON_REF}; Tasks: autostart
Name: "{group}\\Markus"; Filename: "wscript.exe"; Parameters: """{app}\\markus-tray.vbs"""; WorkingDir: "{app}"${WIN_ICON_REF}
Name: "{group}\\Uninstall Markus"; Filename: "{uninstallexe}"

[Run]
Filename: "wscript.exe"; Parameters: """{app}\\markus-tray.vbs"""; Description: "Launch Markus"; Flags: postinstall nowait skipifsilent

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Param + ';', ';' + OrigPath + ';') = 0;
end;

procedure AddToPath();
var
  AppDir, OrigPath, NewPath: string;
begin
  AppDir := ExpandConstant('{app}');
  if NeedsAddPath(AppDir) then
  begin
    if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
      OrigPath := '';
    if OrigPath = '' then
      NewPath := AppDir
    else
      NewPath := OrigPath + ';' + AppDir;
    if not RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', NewPath) then
    begin
      Log('Warning: Could not add to PATH (registry write failed). This is not critical.');
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddToPath();
end;

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
ISS

  info "Building Windows .exe installer via Inno Setup..."
  # Inno Setup location on GitHub Actions windows runners
  ISCC=""
  if [[ -f "/c/Program Files (x86)/Inno Setup 6/ISCC.exe" ]]; then
    ISCC="/c/Program Files (x86)/Inno Setup 6/ISCC.exe"
  elif command -v iscc &>/dev/null; then
    ISCC="iscc"
  elif [[ -f "C:/Program Files (x86)/Inno Setup 6/ISCC.exe" ]]; then
    ISCC="C:/Program Files (x86)/Inno Setup 6/ISCC.exe"
  fi

  if [[ -n "$ISCC" ]]; then
    WIN_ISS_FILE="$(cygpath -w "$ISS_FILE" 2>/dev/null || echo "$ISS_FILE")"
    "$ISCC" "$WIN_ISS_FILE"
    cp "$OUT_DIR/$EXE_VERSIONED" "$OUT_DIR/$EXE_FIXED" 2>/dev/null || true
    ok "Windows installer: $EXE_VERSIONED"
  else
    # Fallback: create a zip if Inno Setup is not available
    info "Inno Setup not found — falling back to .zip archive"
    FALLBACK_ZIP="${ARCHIVE_NAME}.zip"
    EXE_FIXED="markus-setup-win-${ARCH}.zip"
    cd "$OUT_DIR"
    if command -v zip &>/dev/null; then
      zip -qr "$FALLBACK_ZIP" "$ARCHIVE_NAME"
    elif command -v 7z &>/dev/null; then
      7z a -tzip "$FALLBACK_ZIP" "$ARCHIVE_NAME" > /dev/null 2>&1
    else
      powershell -Command "Compress-Archive -Path '$ARCHIVE_NAME' -DestinationPath '$FALLBACK_ZIP'" 2>/dev/null || tar -czf "${ARCHIVE_NAME}.tar.gz" "$ARCHIVE_NAME"
    fi
    cp "$FALLBACK_ZIP" "$EXE_FIXED" 2>/dev/null || true
    cd "$ROOT_DIR"
    ok "Windows archive (fallback): $FALLBACK_ZIP"
  fi

  rm -f "$ISS_FILE"
fi

# ── Step 5: Create portable archive (used by install.sh / install.ps1) ───────
# Native installers above are for direct-download; the archive is for CLI scripts
# that extract to ~/.markus/app/ without requiring root/admin.

if [[ "$PLATFORM" == "win" ]]; then
  if [[ ! -f "$OUT_DIR/${ARCHIVE_NAME}.zip" ]]; then
    info "Creating portable .zip archive..."
    cd "$OUT_DIR"
    if command -v zip &>/dev/null; then
      zip -qr "${ARCHIVE_NAME}.zip" "$(basename "$STAGE_DIR")"
    elif command -v 7z &>/dev/null; then
      7z a -tzip "${ARCHIVE_NAME}.zip" "$(basename "$STAGE_DIR")" > /dev/null 2>&1
    else
      powershell -Command "Compress-Archive -Path '$(basename "$STAGE_DIR")' -DestinationPath '${ARCHIVE_NAME}.zip'" 2>/dev/null || true
    fi
    cd "$ROOT_DIR"
    ok "Portable archive: ${ARCHIVE_NAME}.zip"
  fi
else
  info "Creating portable .tar.gz archive..."
  tar -czf "$OUT_DIR/${ARCHIVE_NAME}.tar.gz" -C "$OUT_DIR" "$(basename "$STAGE_DIR")"
  ok "Portable archive: ${ARCHIVE_NAME}.tar.gz"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
printf "\n"
info "Output files in dist-binary/:"
ls -lh "$OUT_DIR"/markus-*"${PLATFORM}-${ARCH}"* 2>/dev/null || true
printf "\n${GREEN}${BOLD}  Done!${NC}\n\n"
