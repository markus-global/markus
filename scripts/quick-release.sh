#!/usr/bin/env bash
#
# Quick release: bump version, commit, tag, push. CI handles the rest.
#
# Usage:
#   ./scripts/quick-release.sh 0.3.0 "feat: new agent builder"
#   ./scripts/quick-release.sh patch "fix: startup crash"
#   ./scripts/quick-release.sh minor "feat: A2A protocol support"
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'; BOLD='\033[1m'

die() { printf "${RED}✗${NC} %s\n" "$*"; exit 1; }

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ── Args ───────────────────────────────────────────────────────────────────
[[ -z "${1:-}" ]] && die "Usage: $0 <version|patch|minor|major> <message>"
[[ -z "${2:-}" ]] && die "Usage: $0 <version|patch|minor|major> <message>"

BUMP="$1"
MSG="$2"

# ── Compute version ───────────────────────────────────────────────────────
CURRENT="$(node -p "require('./package.json').version")"
IFS='.' read -r MA MI PA <<< "$CURRENT"

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  VER="$BUMP"
else
  case "$BUMP" in
    patch) VER="$MA.$MI.$((PA + 1))" ;;
    minor) VER="$MA.$((MI + 1)).0" ;;
    major) VER="$((MA + 1)).0.0" ;;
    *) die "Invalid: $BUMP (use patch, minor, major, or x.y.z)" ;;
  esac
fi

printf "${BLUE}→${NC} ${BOLD}v${CURRENT}${NC} → ${BOLD}v${VER}${NC}  ${MSG}\n"

# ── Check git status ──────────────────────────────────────────────────────
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" != "main" ]] && die "Not on main (on $BRANCH)"

# ── Update all package.json ───────────────────────────────────────────────
for f in package.json packages/*/package.json; do
  sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$VER\"/" "$f"
done

# ── Commit, tag, push ────────────────────────────────────────────────────
git add -u  # stage all modified tracked files (version bumps + any pending changes)
git add packages/*/README.md 2>/dev/null || true  # include new package READMEs if present
git commit -m "release v${VER}: ${MSG}"
git tag -a "v${VER}" -m "v${VER} — ${MSG}"
git push origin main "v${VER}"

printf "\n${GREEN}✓${NC} ${BOLD}v${VER}${NC} released → CI will publish to npm\n"
printf "  https://github.com/markus-global/markus/actions\n\n"
