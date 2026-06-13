#!/usr/bin/env bash
# Fetches the latest Arena AI leaderboard data and saves it to the repository.
# Run this periodically (e.g., weekly) to keep bundled data fresh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/../packages/core/data"
API_BASE="https://api.wulong.dev/arena-ai-leaderboards/v1"

echo "Updating Arena AI leaderboard data..."

curl -sf --max-time 30 "${API_BASE}/leaderboard?name=text" > "${DATA_DIR}/arena-text.json"
echo "  ✓ text leaderboard"

curl -sf --max-time 30 "${API_BASE}/leaderboard?name=code" > "${DATA_DIR}/arena-code.json"
echo "  ✓ code leaderboard"

curl -sf --max-time 30 "${API_BASE}/leaderboard?name=vision" > "${DATA_DIR}/arena-vision.json"
echo "  ✓ vision leaderboard"

echo ""
echo "Data updated at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Remember to commit the updated files in packages/core/data/"
