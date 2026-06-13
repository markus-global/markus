#!/usr/bin/env bash
# Updates the bundled model catalog data used as the baseline for pricing/specs.
# Run this periodically (e.g., weekly) to keep model pricing data fresh.
#
# What it updates:
#   1. LiteLLM model_prices_and_context_window.json → baseline (covers most major providers)
#   2. Arena AI leaderboard data (via update-arena-data.sh)
#
# The supplements file (model-catalog-supplements.json) covers providers NOT in
# LiteLLM (SiliconFlow, ZAI) and must be updated manually when pricing changes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/../packages/core/data"

LITELLM_URL="https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

echo "=== Updating model catalog baseline ==="
echo "Fetching LiteLLM model pricing data..."

if curl -sf --max-time 60 "${LITELLM_URL}" > "${DATA_DIR}/model-catalog-baseline.json.tmp"; then
  # Validate JSON before replacing
  if python3 -c "import json; json.load(open('${DATA_DIR}/model-catalog-baseline.json.tmp'))" 2>/dev/null; then
    mv "${DATA_DIR}/model-catalog-baseline.json.tmp" "${DATA_DIR}/model-catalog-baseline.json"
    MODEL_COUNT=$(python3 -c "import json; d=json.load(open('${DATA_DIR}/model-catalog-baseline.json')); print(len([k for k in d if k != 'sample_spec']))")
    echo "  ✓ baseline updated (${MODEL_COUNT} models)"
  else
    rm -f "${DATA_DIR}/model-catalog-baseline.json.tmp"
    echo "  ✗ downloaded file is not valid JSON, keeping existing baseline"
  fi
else
  rm -f "${DATA_DIR}/model-catalog-baseline.json.tmp"
  echo "  ✗ download failed, keeping existing baseline"
fi

echo ""
echo "=== Updating Arena AI leaderboard data ==="
bash "${SCRIPT_DIR}/update-arena-data.sh" 2>/dev/null || echo "  ⚠ Arena data update failed (non-critical)"

echo ""
echo "=== Summary ==="
echo "Updated at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""
echo "Note: model-catalog-supplements.json (SiliconFlow, ZAI) must be updated"
echo "manually when those providers change pricing. Check:"
echo "  - https://siliconflow.com/pricing"
echo "  - https://docs.z.ai/guides/overview/pricing"
echo ""
echo "Remember to commit updated files in packages/core/data/"
