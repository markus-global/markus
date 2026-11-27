#!/usr/bin/env bash
#
# Artifact-level gate for macOS releases: proves the shipped DMGs and the
# auto-update ZIPs are both installable and correctly architected.
#
# Why a script and not 60 lines of inline YAML: this must be runnable locally
# against a real build before a release is cut, and it must be the same code in
# the release workflow and the test workflow. See docs/desktop-auto-update.md.
#
# Checks:
#   1. Exactly two DMGs (arm64 + x64) — one mac CI job builds both arches so the
#      single `latest-mac.yml` can list both. Two DMGs from two jobs used to mean
#      two feeds racing for the same filename.
#   2. Each DMG mounts, contains Markus.app, and its main binary matches the arch
#      implied by the filename (hdiutil verify + lipo).
#   3. Each update ZIP extracts to a Markus.app whose code signature verifies and
#      whose arch matches its name — this is the artifact Squirrel.Mac installs.
#   4. With --require-developer-id: the signature must actually verify AND be a
#      Developer ID Application certificate (not ad-hoc / unsigned).
#   5. With --require-notarized: Gatekeeper assessment + stapled ticket pass.
#      Implies --require-developer-id. Only usable on a release build — an
#      intentionally unsigned CI build must not use either flag.
#   6. `scripts/verify-update-feed.mjs --platform mac` passes (zip selectable for
#      both arches, sha512 matching).
#
# Usage: scripts/verify-mac-artifacts.sh [--dir <dist-electron>] [--require-developer-id] [--require-notarized]
set -euo pipefail
shopt -s nullglob

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$REPO_ROOT/packages/desktop/dist-electron"
REQUIRE_DEV_ID=0
REQUIRE_NOTARIZED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIST_DIR="$2"; shift 2 ;;
    --require-developer-id) REQUIRE_DEV_ID=1; shift ;;
    --require-notarized) REQUIRE_DEV_ID=1; REQUIRE_NOTARIZED=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "::error::$*" >&2; exit 1; }
info() { echo "→ $*"; }

[ -d "$DIST_DIR" ] || fail "dist dir not found: $DIST_DIR"

dmgs=("$DIST_DIR"/*.dmg)
zips=("$DIST_DIR"/*.zip)

[ "${#dmgs[@]}" -eq 2 ] || fail "expected exactly 2 DMGs (arm64 + x64), found ${#dmgs[@]}: ${dmgs[*]:-none}"
[ "${#zips[@]}" -eq 2 ] || fail "expected exactly 2 update ZIPs (arm64 + x64), found ${#zips[@]}: ${zips[*]:-none}"

# `Markus-0.12.4-arm64.dmg` vs `Markus-0.12.4.dmg`: electron-builder omits the
# arch suffix for x64, and electron-updater's MacUpdater uses the same heuristic
# (`url.includes("arm64")`) to pick a feed entry, so this is the real contract.
expected_arch() { case "$1" in *arm64*) echo arm64 ;; *) echo x86_64 ;; esac; }
assert_arch() {
  local binary="$1" want="$2" label="$3"
  local got
  got="$(lipo -archs "$binary")"
  echo "   $label arch: $got (want: $want)"
  echo "$got" | grep -q "$want" || fail "$label: expected $want, got '$got'"
}

MOUNTROOT="$(mktemp -d /tmp/markus-artifacts-XXXXXX)"
WORKDIR="$(mktemp -d /tmp/markus-unzip-XXXXXX)"
cleanup() {
  if [ -d "$MOUNTROOT" ]; then
    while IFS= read -r vol; do
      # Under `set -e` a failed detach on an already-gone volume must not abort cleanup.
      hdiutil detach "$vol" -force >/dev/null 2>&1 || true
    done < <(find "$MOUNTROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true)
    rm -rf "$MOUNTROOT" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR" 2>/dev/null || true
}
trap cleanup EXIT

for dmg in "${dmgs[@]}"; do
  info "hdiutil verify $(basename "$dmg")"
  hdiutil verify "$dmg" >/dev/null

  # Volume names contain spaces ("Markus 0.12.4 arm64"); never parse hdiutil's
  # tabular output with awk $NF — use a private mountroot instead.
  info "hdiutil attach $(basename "$dmg")"
  hdiutil attach "$dmg" -nobrowse -readonly -mountroot "$MOUNTROOT" >/dev/null
  app="$(find "$MOUNTROOT" -maxdepth 2 -name 'Markus.app' -type d | head -n 1)"
  [ -n "$app" ] || fail "Markus.app not found inside $(basename "$dmg")"
  assert_arch "$app/Contents/MacOS/Markus" "$(expected_arch "$dmg")" "dmg $(basename "$dmg")"
  while IFS= read -r vol; do
    hdiutil detach "$vol" -force >/dev/null 2>&1 || true
  done < <(find "$MOUNTROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true)
done

for zip in "${zips[@]}"; do
  name="$(basename "$zip")"
  out="$WORKDIR/$name"
  mkdir -p "$out"
  info "unzip $name"
  # ditto, not unzip: it preserves the symlinks and extended attributes that make
  # the bundle signature validate after extraction.
  ditto -x -k "$zip" "$out"
  app="$out/Markus.app"
  [ -d "$app" ] || fail "$name does not contain Markus.app at its root"
  assert_arch "$app/Contents/MacOS/Markus" "$(expected_arch "$name")" "zip $name"

  # Signature strength is a release concern, not a structure concern: an unsigned
  # build (`CSC_IDENTITY_AUTO_DISCOVERY=false`, used by the PR gate) has nothing
  # to verify, and failing it there would only teach people to skip this script.
  if [ "$REQUIRE_DEV_ID" -eq 1 ]; then
    info "codesign --verify $name"
    codesign --verify --deep --strict "$app" || fail "$name: code signature does not verify"
    authority="$(codesign -dv --verbose=4 "$app" 2>&1 | grep -m1 '^Authority=' || true)"
    echo "   $authority"
    case "$authority" in
      *"Developer ID Application"*) : ;;
      *) fail "$name is not signed with a Developer ID Application certificate — Squirrel.Mac and Gatekeeper will reject the update" ;;
    esac
  else
    echo "   (signature not enforced — pass --require-developer-id for a release build)"
  fi

  if [ "$REQUIRE_NOTARIZED" -eq 1 ]; then
    info "spctl assess $name"
    spctl -a -vv "$app" || fail "$name fails Gatekeeper assessment"
    info "stapler validate $name"
    # Notarization tickets must be stapled to the app inside the ZIP, otherwise a
    # first launch offline (or behind a firewall) trips Gatekeeper.
    xcrun stapler validate "$app" || fail "$name is not notarized/stapled"
  fi
done

info "verify update feed"
node "$REPO_ROOT/scripts/verify-update-feed.mjs" --dir "$DIST_DIR" --platform mac

echo "✔ macOS artifacts verified (${#dmgs[@]} DMGs, ${#zips[@]} update ZIPs)"
