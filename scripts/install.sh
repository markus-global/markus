#!/usr/bin/env bash
#
# Markus — AI Digital Workforce Platform
# One-line installer: curl -fsSL https://get.markus.global/install.sh | bash
#
set -euo pipefail

VERSION="latest"
NPM_PACKAGE="@markus-global/cli"

# ─── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

info()  { printf "${BLUE}  [info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}  [ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}  [warn]${NC}  %s\n" "$*"; }
error() { printf "${RED}  [error]${NC} %s\n" "$*"; }

# ─── Banner ──────────────────────────────────────────────────────────────────

banner() {
  printf "\n"
  printf "${CYAN}${BOLD}"
  printf "  ┌─────────────────────────────────────┐\n"
  printf "  │         Markus Installer             │\n"
  printf "  │   AI Digital Workforce Platform      │\n"
  printf "  └─────────────────────────────────────┘\n"
  printf "${NC}\n"
}

# ─── OS / Arch detection ────────────────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos"  ;;
    Linux)  echo "linux"  ;;
    *)      echo "unknown" ;;
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
  if [ "$ver" -lt 20 ] 2>/dev/null; then
    return 2
  fi
  return 0
}

install_node_guidance() {
  local os="$1"
  error "Node.js 20+ is required but not found."
  printf "\n"
  info "Install Node.js using one of these methods:"
  printf "\n"
  if [ "$os" = "macos" ]; then
    printf "    ${BOLD}Option 1: nvm (recommended)${NC}\n"
    printf "      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n"
    printf "      nvm install 22\n"
    printf "\n"
    printf "    ${BOLD}Option 2: Homebrew${NC}\n"
    printf "      brew install node@22\n"
    printf "\n"
    printf "    ${BOLD}Option 3: Official installer${NC}\n"
    printf "      https://nodejs.org/en/download\n"
  else
    printf "    ${BOLD}Option 1: nvm (recommended)${NC}\n"
    printf "      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash\n"
    printf "      nvm install 22\n"
    printf "\n"
    printf "    ${BOLD}Option 2: Package manager${NC}\n"
    printf "      # Ubuntu/Debian\n"
    printf "      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\n"
    printf "      sudo apt-get install -y nodejs\n"
    printf "\n"
    printf "    ${BOLD}Option 3: Official binary${NC}\n"
    printf "      https://nodejs.org/en/download\n"
  fi
  printf "\n"
  info "After installing Node.js, re-run this installer."
}

check_npm() {
  if ! command -v npm &>/dev/null; then
    error "npm is required but not found (should come with Node.js)."
    return 1
  fi
  return 0
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
    error "Markus currently supports macOS and Linux."
    exit 1
  fi

  # Step 1: Check Node.js
  info "Checking Node.js..."
  if ! check_node; then
    local exit_code=$?
    if [ "$exit_code" -eq 2 ]; then
      local current_ver
      current_ver="$(node -v)"
      error "Node.js $current_ver is too old. Version 20+ is required."
      printf "\n"
    fi
    install_node_guidance "$os"
    exit 1
  fi
  ok "Node.js $(node -v)"

  # Step 2: Check npm
  if ! check_npm; then
    exit 1
  fi
  ok "npm $(npm -v)"

  # Step 3: Install @markus-global/cli
  info "Installing ${NPM_PACKAGE}..."
  printf "\n"

  if npm install -g "${NPM_PACKAGE}@${VERSION}"; then
    ok "Installed @markus-global/cli"
  else
    printf "\n"
    warn "Global install failed (may need elevated permissions)."
    info "Trying with sudo..."
    if sudo npm install -g "${NPM_PACKAGE}@${VERSION}"; then
      ok "Installed @markus-global/cli (with sudo)"
    else
      error "Installation failed. Try manually:"
      printf "    npm install -g ${NPM_PACKAGE}\n"
      exit 1
    fi
  fi

  printf "\n"

  # Step 4: Verify installation
  if ! command -v markus &>/dev/null; then
    warn "markus command not found in PATH."
    warn "You may need to add npm global bin to your PATH:"
    printf "    export PATH=\"\$(npm prefix -g)/bin:\$PATH\"\n"
    printf "\n"
  else
    ok "markus $(markus --version 2>/dev/null || echo 'installed')"
  fi

  # Step 5: Run init
  info "Running setup wizard..."
  printf "\n"
  markus init 2>/dev/null || true

  printf "\n"
  printf "${GREEN}${BOLD}"
  printf "  ┌─────────────────────────────────────┐\n"
  printf "  │     Installation Complete!           │\n"
  printf "  └─────────────────────────────────────┘\n"
  printf "${NC}\n"
  printf "  Quick start:\n"
  printf "\n"
  printf "    ${BOLD}markus start${NC}          Launch the platform\n"
  printf "    ${BOLD}markus agent list${NC}     List your agents\n"
  printf "    ${BOLD}markus --help${NC}         Show all commands\n"
  printf "\n"
  printf "  Documentation:  https://github.com/markus-global/markus\n"
  printf "\n"
}

main "$@"
