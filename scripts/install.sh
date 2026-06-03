#!/usr/bin/env bash
#
# Markus — AI Digital Workforce Platform
# One-line installer: curl -fsSL https://markus.global/install.sh | bash
#
# If Node.js 22+ is present  → lightweight npm install (~5 MB)
# If Node.js is missing       → downloads standalone binary with bundled runtime (~45 MB)
#
# Post-install: PATH registration.
#
set -euo pipefail

VERSION="latest"
NPM_PACKAGE="@markus-global/cli"
GITHUB_REPO="markus-global/markus"
INSTALL_DIR="$HOME/.markus/app"

# ─── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'
BOLD='\033[1m'

info()  { printf "${BLUE}  [info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}  [ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}  [warn]${NC}  %s\n" "$*"; }
error() { printf "${RED}  [error]${NC} %s\n" "$*"; }

# ─── Spinner ─────────────────────────────────────────────────────────────────

SPINNER_PID=""
spinner_start() {
  local msg="$1"
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local i=0 elapsed=0
  (
    while true; do
      local f="${frames[$((i % ${#frames[@]}))]}"
      if [ "$elapsed" -ge 5 ]; then
        printf "\r  ${CYAN}%s${NC}  %s ${DIM}(%ds)${NC}  " "$f" "$msg" "$elapsed"
      else
        printf "\r  ${CYAN}%s${NC}  %s  " "$f" "$msg"
      fi
      sleep 0.5
      i=$((i + 1))
      elapsed=$((i / 2))
    done
  ) &
  SPINNER_PID=$!
}

spinner_stop() {
  if [ -n "$SPINNER_PID" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
    kill "$SPINNER_PID" 2>/dev/null
    wait "$SPINNER_PID" 2>/dev/null || true
    printf "\r\033[K"
  fi
  SPINNER_PID=""
}

trap 'spinner_stop' EXIT

# ─── Banner ──────────────────────────────────────────────────────────────────

banner() {
  printf "\n"
  printf "${CYAN}${BOLD}"
  printf "  ┌─────────────────────────────────────┐\n"
  printf "  │         Markus Installer            │\n"
  printf "  │   AI Digital Workforce Platform     │\n"
  printf "  └─────────────────────────────────────┘\n"
  printf "${NC}\n"
}

# ─── OS / Arch detection ────────────────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Darwin)          echo "darwin" ;;
    Linux)           echo "linux"  ;;
    MINGW*|MSYS*|CYGWIN*) echo "win" ;;
    *)               echo "unknown" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "x64"   ;;
    arm64|aarch64) echo "arm64" ;;
    *)             echo "unknown" ;;
  esac
}

# ─── Dependency checks ──────────────────────────────────────────────────────

check_node() {
  if ! command -v node &>/dev/null; then
    return 1
  fi
  local ver
  ver="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$ver" -lt 22 ] 2>/dev/null; then
    return 2
  fi
  return 0
}

check_npm() {
  command -v npm &>/dev/null
}

# ─── Resolve latest version tag from GitHub (fallback to hub mirror) ──────────

resolve_latest_version() {
  local tag
  # Try GitHub API first
  tag="$(curl -fsSL --connect-timeout 5 "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
    | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/')"
  if [ -n "$tag" ]; then echo "$tag"; return; fi
  # Fallback to hub API
  tag="$(curl -fsSL --connect-timeout 10 "https://markus.global/api/releases/latest" 2>/dev/null \
    | grep '"version"' | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  echo "$tag"
}

# ─── npm install path ───────────────────────────────────────────────────────

npm_install_global() {
  local pkg="$1"
  local logfile
  logfile="$(mktemp /tmp/markus-install-XXXXXX)"
  local install_cmd="npm install -g --no-audit --no-fund --ignore-optional --loglevel=error $pkg"

  spinner_start "Installing ${pkg} via npm..."

  if $install_cmd >"$logfile" 2>&1; then
    spinner_stop
    ok "Installed @markus-global/cli via npm"
    rm -f "$logfile"
    return 0
  fi

  spinner_stop
  error "npm installation failed. Output:"
  printf "\n"
  cat "$logfile"
  printf "\n"
  info "If you see permission errors, fix npm prefix instead of using sudo:"
  printf "    ${BOLD}mkdir -p ~/.npm-global${NC}\n"
  printf "    ${BOLD}npm config set prefix ~/.npm-global${NC}\n"
  printf "    ${BOLD}export PATH=~/.npm-global/bin:\$PATH${NC}  (add to ~/.zshrc or ~/.bashrc)\n"
  printf "\n"
  rm -f "$logfile"
  return 1
}

# ─── Binary install path ────────────────────────────────────────────────────

binary_install() {
  local os="$1" arch="$2"

  info "Node.js not found — downloading standalone binary (includes runtime)..."

  local ver
  ver="$(resolve_latest_version)"
  if [ -z "$ver" ]; then
    error "Could not determine latest release version."
    error "Check your network connection and try again."
    return 1
  fi
  info "Latest version: v${ver}"

  local archive_name="markus-v${ver}-${os}-${arch}"
  local ext="tar.gz"
  local github_url="https://github.com/${GITHUB_REPO}/releases/download/v${ver}/${archive_name}.${ext}"
  local mirror_url="https://markus.global/releases/${archive_name}.${ext}"

  local tmpdir
  tmpdir="$(mktemp -d /tmp/markus-download-XXXXXX)"

  spinner_start "Downloading ${archive_name}.${ext}..."
  if ! curl -fSL --connect-timeout 8 --max-time 120 -o "$tmpdir/${archive_name}.${ext}" "$github_url" 2>/dev/null; then
    spinner_stop
    warn "GitHub download failed or timed out, trying mirror..."
    spinner_start "Downloading from mirror..."
    if ! curl -fSL --connect-timeout 15 --max-time 300 -o "$tmpdir/${archive_name}.${ext}" "$mirror_url" 2>/dev/null; then
      spinner_stop
      error "Download failed from both GitHub and mirror."
      error "Binary for ${os}-${arch} may not be available yet for v${ver}."
      rm -rf "$tmpdir"
      return 1
    fi
  fi
  spinner_stop
  ok "Downloaded ${archive_name}.${ext}"

  # Extract
  info "Extracting to ${INSTALL_DIR}..."
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -xzf "$tmpdir/${archive_name}.${ext}" -C "$INSTALL_DIR" --strip-components=1
  chmod +x "$INSTALL_DIR/markus" "$INSTALL_DIR/bin/node" 2>/dev/null || true
  ok "Extracted to ${INSTALL_DIR}"

  rm -rf "$tmpdir"
  return 0
}

# ─── Post-install: PATH registration ────────────────────────────────────────

setup_path() {
  local install_mode="$1"

  if [ "$install_mode" = "binary" ]; then
    local target_dir="$INSTALL_DIR"
    local shell_name rc_file line

    shell_name="$(basename "${SHELL:-/bin/bash}")"
    case "$shell_name" in
      zsh)  rc_file="$HOME/.zshrc" ;;
      bash) rc_file="$HOME/.bashrc" ;;
      fish) rc_file="$HOME/.config/fish/config.fish" ;;
      *)    rc_file="$HOME/.profile" ;;
    esac

    if [ "$shell_name" = "fish" ]; then
      line="set -gx PATH $target_dir \$PATH"
    else
      line="export PATH=\"$target_dir:\$PATH\""
    fi

    if [ -f "$rc_file" ] && grep -qF "$target_dir" "$rc_file" 2>/dev/null; then
      ok "PATH already configured in $rc_file"
    else
      printf "\n# Markus — AI Digital Workforce Platform\n%s\n" "$line" >> "$rc_file"
      ok "Added to PATH via $rc_file"
    fi

    export PATH="$target_dir:$PATH"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  banner

  local os arch
  os="$(detect_os)"
  arch="$(detect_arch)"

  info "Detected: $os / $arch"

  if [ "$os" = "unknown" ]; then
    error "Unsupported operating system: $(uname -s)"
    error "Markus supports macOS, Linux, and Windows (PowerShell installer)."
    exit 1
  fi
  if [ "$arch" = "unknown" ]; then
    error "Unsupported architecture: $(uname -m)"
    exit 1
  fi

  # ── Choose install path: npm (lightweight) or binary (standalone) ──────
  local install_mode="npm"
  local markus_cmd="markus"

  info "Checking Node.js..."
  if check_node; then
    ok "Node.js $(node -v)"
    if check_npm; then
      ok "npm $(npm -v)"
      printf "\n"
      if ! npm_install_global "${NPM_PACKAGE}@${VERSION}"; then
        exit 1
      fi
    else
      error "npm not found — falling back to binary install"
      install_mode="binary"
    fi
  else
    if command -v node &>/dev/null; then
      warn "Node.js $(node -v) is too old (22+ required) — using standalone binary"
    else
      info "Node.js not found — using standalone binary (includes runtime)"
    fi
    install_mode="binary"
  fi

  if [ "$install_mode" = "binary" ]; then
    printf "\n"
    if ! binary_install "$os" "$arch"; then
      exit 1
    fi
    markus_cmd="$INSTALL_DIR/markus"
  fi

  printf "\n"

  # ── PATH registration ─────────────────────────────────────────────────
  setup_path "$install_mode"

  # ── Verify installation ───────────────────────────────────────────────
  if [ "$install_mode" = "npm" ]; then
    if ! command -v markus &>/dev/null; then
      warn "markus command not found in PATH."
      warn "You may need to add npm global bin to your PATH:"
      printf "    export PATH=\"\$(npm prefix -g)/bin:\$PATH\"\n\n"
      markus_cmd="npx @markus-global/cli"
    else
      ok "markus $(markus --version 2>/dev/null || echo 'installed')"
    fi
  else
    ok "markus installed at $INSTALL_DIR"
  fi

  # ── Success banner ────────────────────────────────────────────────────
  printf "\n"
  printf "${GREEN}${BOLD}"
  printf "  ┌─────────────────────────────────────┐\n"
  printf "  │     Installation Complete!          │\n"
  printf "  └─────────────────────────────────────┘\n"
  printf "${NC}\n"
  printf "  Quick start:\n\n"

  if [ "$install_mode" = "binary" ]; then
    printf "    ${BOLD}markus start${NC}          Launch the platform\n"
    printf "    ${BOLD}markus agent list${NC}     List your agents\n"
    printf "    ${BOLD}markus --help${NC}         Show all commands\n"
    printf "\n"
    printf "  ${DIM}(restart your terminal for PATH changes to take effect)${NC}\n"
  elif command -v markus &>/dev/null; then
    printf "    ${BOLD}markus start${NC}          Launch the platform\n"
    printf "    ${BOLD}markus agent list${NC}     List your agents\n"
    printf "    ${BOLD}markus --help${NC}         Show all commands\n"
  else
    printf "    ${BOLD}npx @markus-global/cli start${NC}          Launch the platform\n"
    printf "    ${BOLD}npx @markus-global/cli agent list${NC}     List your agents\n"
    printf "    ${BOLD}npx @markus-global/cli --help${NC}         Show all commands\n"
  fi

  printf "\n"
  printf "  ${DIM}Upgrade:${NC}  curl -fsSL https://markus.global/install.sh | bash\n"
  printf "  ${DIM}Uninstall:${NC} markus uninstall\n"
  printf "\n"
  printf "  Documentation:  https://github.com/markus-global/markus\n"
  printf "\n"
}

main "$@"
