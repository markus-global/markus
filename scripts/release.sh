#!/usr/bin/env bash
#
# Markus release script
#
# Usage:
#   ./scripts/release.sh patch    # 0.1.0 → 0.1.1
#   ./scripts/release.sh minor    # 0.1.0 → 0.2.0
#   ./scripts/release.sh major    # 0.1.0 → 1.0.0
#   ./scripts/release.sh 0.3.0    # explicit version
#
# Pre-release:
#   ./scripts/release.sh rc       # 0.7.2 → 0.7.3-rc.0 (first RC)
#   ./scripts/release.sh rc       # 0.7.3-rc.0 → 0.7.3-rc.1 (next RC)
#   ./scripts/release.sh promote  # 0.7.3-rc.1 → 0.7.3 (stable)
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'; BOLD='\033[1m'

info()  { printf "${BLUE}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$*"; }
die()   { printf "${RED}[error]${NC} %s\n" "$*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── Preflight checks ────────────────────────────────────────────────────────

[[ -z "${1:-}" ]] && die "Usage: $0 <patch|minor|major|rc|promote|x.y.z>"

# Must be on main branch with clean working tree
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" != "main" ]] && die "Must be on 'main' branch (currently on '$BRANCH')"

if [[ -n "$(git status --porcelain)" ]]; then
  die "Working tree is dirty. Commit or stash changes first."
fi

# Ensure npm auth
if ! npm whoami &>/dev/null; then
  die "Not logged in to npm. Run 'npm login' first."
fi

# ── Compute new version ─────────────────────────────────────────────────────

CURRENT_VERSION="$(node -p "require('./package.json').version")"
BUMP="$1"
BASE_VERSION="${CURRENT_VERSION%%-*}"
IFS='.' read -r V_MAJOR V_MINOR V_PATCH <<< "$BASE_VERSION"

IS_PRERELEASE=false

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  NEW_VERSION="$BUMP"
elif [[ "$BUMP" == "rc" ]]; then
  IS_PRERELEASE=true
  if [[ "$CURRENT_VERSION" == *"-rc."* ]]; then
    RC_NUM="${CURRENT_VERSION##*-rc.}"
    NEW_VERSION="${BASE_VERSION}-rc.$((RC_NUM + 1))"
  else
    NEW_VERSION="$V_MAJOR.$V_MINOR.$((V_PATCH + 1))-rc.0"
  fi
elif [[ "$BUMP" == "promote" ]]; then
  if [[ "$CURRENT_VERSION" != *"-rc."* ]]; then
    die "Cannot promote: current version ($CURRENT_VERSION) is not an RC"
  fi
  NEW_VERSION="$BASE_VERSION"
else
  case "$BUMP" in
    patch|minor|major) ;;
    *) die "Invalid bump type: $BUMP (use patch, minor, major, rc, promote, or x.y.z)" ;;
  esac
  case "$BUMP" in
    patch) NEW_VERSION="$V_MAJOR.$V_MINOR.$((V_PATCH + 1))" ;;
    minor) NEW_VERSION="$V_MAJOR.$((V_MINOR + 1)).0" ;;
    major) NEW_VERSION="$((V_MAJOR + 1)).0.0" ;;
  esac
fi

[[ "$NEW_VERSION" == *"-"* ]] && IS_PRERELEASE=true

info "Version bump: ${BOLD}$CURRENT_VERSION${NC} → ${BOLD}$NEW_VERSION${NC}"
$IS_PRERELEASE && warn "Pre-release: will publish to npm with --tag next"
printf "\nProceed? (y/n) "
read -r CONFIRM
[[ "$CONFIRM" != "y" ]] && die "Aborted."

# ── Step 1: Update version in all package.json files ────────────────────────

info "Updating versions..."

# Root package.json
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json','utf8'));
  p.version = '$NEW_VERSION';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"

# All workspace packages
for pkg in packages/*/package.json; do
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$pkg','utf8'));
    p.version = '$NEW_VERSION';
    fs.writeFileSync('$pkg', JSON.stringify(p, null, 2) + '\n');
  "
done

ok "All package.json files updated to $NEW_VERSION"

# ── Step 2: Full build ──────────────────────────────────────────────────────

info "Running full build..."
pnpm install
pnpm build

info "Building Web UI..."
pnpm --filter @markus/web-ui build

info "Building CLI bundle..."
pnpm --filter @markus-global/cli build:bundle

ok "Build complete"

# ── Step 2b: Sync install script to markus-hub ───────────────────────────────

MARKUS_HUB_DIR="$ROOT_DIR/../markus-hub"
if [[ -d "$MARKUS_HUB_DIR" ]]; then
  info "Syncing install.sh → markus-hub..."
  mkdir -p "$MARKUS_HUB_DIR/scripts"
  cp "$ROOT_DIR/scripts/install.sh" "$MARKUS_HUB_DIR/scripts/install.sh"
  ok "install.sh synced to markus-hub/scripts/"
else
  warn "markus-hub repo not found at $MARKUS_HUB_DIR — skipping install.sh sync"
fi

# ── Step 3: Verify bundle ───────────────────────────────────────────────────

BUNDLE="packages/cli/dist/markus.mjs"
if [[ ! -f "$BUNDLE" ]]; then
  die "Bundle not found at $BUNDLE"
fi
BUNDLE_SIZE=$(du -h "$BUNDLE" | cut -f1)
ok "Bundle: $BUNDLE ($BUNDLE_SIZE)"

if [[ ! -d "packages/cli/dist/web-ui" ]]; then
  warn "Web UI assets not found in bundle — users won't have built-in UI"
fi

if [[ ! -d "packages/cli/templates" ]]; then
  warn "Templates not found in CLI package"
fi

# ── Step 4: Dry-run publish ─────────────────────────────────────────────────

info "Running npm publish dry-run..."
cd packages/cli
npm publish --dry-run 2>&1 | tail -20
cd "$ROOT_DIR"

printf "\nPublish to npm? (y/n) "
read -r PUB_CONFIRM
if [[ "$PUB_CONFIRM" != "y" ]]; then
  warn "Skipping npm publish. You can publish manually:"
  if $IS_PRERELEASE; then
    printf "  cd packages/cli && npm publish --access public --tag next\n"
  else
    printf "  cd packages/cli && npm publish --access public\n"
  fi
else
  # ── Step 5: Publish to npm ────────────────────────────────────────────────
  NPM_TAG="latest"
  if $IS_PRERELEASE; then
    NPM_TAG="next"
    info "Publishing @markus-global/cli@$NEW_VERSION to npm (tag: next)..."
  else
    info "Publishing @markus-global/cli@$NEW_VERSION to npm..."
  fi
  cd packages/cli
  npm publish --access public --tag "$NPM_TAG"
  cd "$ROOT_DIR"
  ok "Published @markus-global/cli@$NEW_VERSION (tag: $NPM_TAG)"
fi

# ── Step 6: Git tag & commit ────────────────────────────────────────────────

COMMIT_PREFIX="release"
$IS_PRERELEASE && COMMIT_PREFIX="prerelease"

info "Creating git commit and tag..."
git add -A
git commit -m "${COMMIT_PREFIX}: v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"

printf "\nPush to origin? (y/n) "
read -r PUSH_CONFIRM
if [[ "$PUSH_CONFIRM" == "y" ]]; then
  git push origin main --tags
  ok "Pushed to origin with tags"
else
  warn "Remember to push: git push origin main --tags"
fi

printf "\n${GREEN}${BOLD}Release v$NEW_VERSION complete!${NC}\n\n"
printf "  npm:     https://www.npmjs.com/package/@markus-global/cli\n"
if $IS_PRERELEASE; then
  printf "  install: npm i -g @markus-global/cli@next\n"
  printf "  ${YELLOW}Note: this is a pre-release. install.sh still resolves the latest stable.${NC}\n"
else
  printf "  install: curl -fsSL https://markus.global/install.sh | bash\n"
fi
printf "\n"
