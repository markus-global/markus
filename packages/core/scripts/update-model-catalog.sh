#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# update-model-catalog.sh — Update model catalog from LiteLLM prices
#
# Fetches the latest LiteLLM model_prices_and_context_window.json and saves
# it as the baseline catalog file used by ModelCatalogService.
#
# Usage: ./scripts/update-model-catalog.sh [--mirror URL]
#
# Options:
#   --mirror URL  Use a mirror URL instead of the default GitHub raw URL
#
# Files updated:
#   data/model-catalog-baseline.json
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data"

# --- Configuration ---
DEFAULT_URL="https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
TIMEOUT_SEC=60
MAX_RETRIES=3

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
error() { echo "[ERROR] $*" >&2; }

# Parse args
MIRROR_URL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mirror)
      MIRROR_URL="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

CATALOG_URL="${MIRROR_URL:-$DEFAULT_URL}"

# --- Helper: download with retry + backoff ---
download_with_retry() {
  local url="$1"
  local output="$2"
  local retries=0

  while [ $retries -lt $MAX_RETRIES ]; do
    log "Downloading (attempt $((retries + 1))/$MAX_RETRIES)..."
    if curl -sS --max-time "$TIMEOUT_SEC" -L "$url" -o "$output" 2>/dev/null; then
      if [ -s "$output" ]; then
        log "Downloaded $(wc -c < "$output") bytes"
        return 0
      fi
    fi
    retries=$((retries + 1))
    local wait=$((retries * 5))
    error "Attempt $retries failed, waiting ${wait}s before retry..."
    sleep "$wait"
  done

  return 1
}

# --- Main ---
log "Starting model catalog update..."

mkdir -p "$DATA_DIR"

TEMP_FILE=$(mktemp)

if download_with_retry "$CATALOG_URL" "$TEMP_FILE"; then
  # Validate JSON
  if python3 -c "import json; json.load(open('$TEMP_FILE'))" 2>/dev/null; then
    # Check that it has the expected structure (sample_spec key)
    if python3 -c "
import json
data = json.load(open('$TEMP_FILE'))
if 'sample_spec' in data:
    print('Catalog validated: contains sample_spec')
else:
    print('Warning: no sample_spec found, might be unexpected format')
print(f'Total entries: {len(data)}')
" 2>/dev/null; then
      cp "$TEMP_FILE" "$DATA_DIR/model-catalog-baseline.json"
      log "Updated model-catalog-baseline.json ($(wc -c < "$DATA_DIR/model-catalog-baseline.json") bytes)"
    else
      error "Validation failed, keeping existing file"
    fi
  else
    error "Invalid JSON from catalog URL, keeping existing file"
  fi
else
  error "Failed to download catalog after $MAX_RETRIES attempts, keeping existing file"
fi

rm -f "$TEMP_FILE"

log "Model catalog update complete."
