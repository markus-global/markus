#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# update-arena-data.sh — Update Arena benchmark data from lmarena.ai
#
# Fetches the latest Chatbot Arena Elo scores and generates the three JSON
# data files used by ModelScoreService for model quality estimation.
#
# Usage: ./scripts/update-arena-data.sh
#
# Files updated:
#   data/arena-text.json  — Text benchmark Elo scores
#   data/arena-code.json  — Code benchmark Elo scores
#   data/arena-vision.json — Vision benchmark Elo scores
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data"

# --- Configuration ---
ARENA_TEXT_URL="https://lmarena.ai/data/leaderboard_text.json"
ARENA_CODE_URL="https://lmarena.ai/data/leaderboard_code.json"
ARENA_VISION_URL="https://lmarena.ai/data/leaderboard_vision.json"
TIMEOUT_SEC=30
MAX_RETRIES=3

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
error() { echo "[ERROR] $*" >&2; }

# --- Helper: download with retry ---
download_file() {
  local url="$1"
  local output="$2"
  local retries=0

  while [ $retries -lt $MAX_RETRIES ]; do
    if curl -sS --max-time "$TIMEOUT_SEC" "$url" -o "$output" 2>/dev/null; then
      if [ -s "$output" ]; then
        return 0
      fi
    fi
    retries=$((retries + 1))
    log "Retry $retries/$MAX_RETRIES for $url"
    sleep $((retries * 2))
  done

  return 1
}

# --- Main ---
log "Starting Arena data update..."

mkdir -p "$DATA_DIR"

# Download text leaderboard
log "Fetching text benchmark data..."
TEMP_TEXT=$(mktemp)
if download_file "$ARENA_TEXT_URL" "$TEMP_TEXT"; then
  # Validate JSON before copying
  if python3 -c "import json; json.load(open('$TEMP_TEXT'))" 2>/dev/null; then
    cp "$TEMP_TEXT" "$DATA_DIR/arena-text.json"
    log "Updated arena-text.json"
  else
    error "Invalid JSON from text leaderboard"
  fi
else
  error "Failed to fetch text leaderboard, keeping existing file"
fi
rm -f "$TEMP_TEXT"

# Download code leaderboard
log "Fetching code benchmark data..."
TEMP_CODE=$(mktemp)
if download_file "$ARENA_CODE_URL" "$TEMP_CODE"; then
  if python3 -c "import json; json.load(open('$TEMP_CODE'))" 2>/dev/null; then
    cp "$TEMP_CODE" "$DATA_DIR/arena-code.json"
    log "Updated arena-code.json"
  else
    error "Invalid JSON from code leaderboard"
  fi
else
  error "Failed to fetch code leaderboard, keeping existing file"
fi
rm -f "$TEMP_CODE"

# Download vision leaderboard
log "Fetching vision benchmark data..."
TEMP_VISION=$(mktemp)
if download_file "$ARENA_VISION_URL" "$TEMP_VISION"; then
  if python3 -c "import json; json.load(open('$TEMP_VISION'))" 2>/dev/null; then
    cp "$TEMP_VISION" "$DATA_DIR/arena-vision.json"
    log "Updated arena-vision.json"
  else
    error "Invalid JSON from vision leaderboard"
  fi
else
  error "Failed to fetch vision leaderboard, keeping existing file"
fi
rm -f "$TEMP_VISION"

log "Arena data update complete."
