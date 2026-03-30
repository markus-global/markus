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

[[ -z "${1:-}" ]] && die "Usage: $0 <patch|minor|major|x.y.z>"

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

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP"
else
  case "$BUMP" in
    patch|minor|major) ;;
    *) die "Invalid bump type: $BUMP (use patch, minor, major, or x.y.z)" ;;
  esac
  IFS='.' read -r V_MAJOR V_MINOR V_PATCH <<< "$CURRENT_VERSION"
  case "$BUMP" in
    patch) NEW_VERSION="$V_MAJOR.$V_MINOR.$((V_PATCH + 1))" ;;
    minor) NEW_VERSION="$V_MAJOR.$((V_MINOR + 1)).0" ;;
    major) NEW_VERSION="$((V_MAJOR + 1)).0.0" ;;
  esac
fi

info "Version bump: ${BOLD}$CURRENT_VERSION${NC} → ${BOLD}$NEW_VERSION${NC}"
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
  printf "  cd packages/cli && npm publish --access public\n"
else
  # ── Step 5: Publish to npm ────────────────────────────────────────────────
  info "Publishing @markus-global/cli@$NEW_VERSION to npm..."
  cd packages/cli
  npm publish --access public
  cd "$ROOT_DIR"
  ok "Published @markus-global/cli@$NEW_VERSION"
fi

# ── Step 6: Git tag & commit ────────────────────────────────────────────────

info "Creating git commit and tag..."
git add -A
git commit -m "release: v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"

printf "\nPush to origin? (y/n) "
read -r PUSH_CONFIRM
if [[ "$PUSH_CONFIRM" == "y" ]]; then
  git push origin main --tags
  ok "Pushed to origin with tags"
else
  warn "Remember to push: git push origin main --tags"
fi

# ── Step 7: Docker image (optional) ────────────────────────────────────────

printf "\nBuild & push Docker image? (y/n) "
read -r DOCKER_CONFIRM
if [[ "$DOCKER_CONFIRM" == "y" ]]; then
  info "Building Docker image..."
  docker build -t "markus/markus:$NEW_VERSION" -t "markus/markus:latest" .
  info "Pushing Docker image..."
  docker push "markus/markus:$NEW_VERSION"
  docker push "markus/markus:latest"
  ok "Docker image pushed: markus/markus:$NEW_VERSION"
else
  info "Skip Docker. Build manually:"
  printf "  docker build -t markus/markus:$NEW_VERSION -t markus/markus:latest .\n"
  printf "  docker push markus/markus:$NEW_VERSION && docker push markus/markus:latest\n"
fi

printf "\n${GREEN}${BOLD}Release v$NEW_VERSION complete!${NC}\n\n"
printf "  npm:     https://www.npmjs.com/package/@markus-global/cli\n"
printf "  install: curl -fsSL https://markus.global/install.sh | bash\n"
printf "  docker:  docker pull markus/markus:$NEW_VERSION\n\n"
