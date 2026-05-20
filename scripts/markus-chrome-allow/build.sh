#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building markus-chrome-allow..."
swiftc -O main.swift -o markus-chrome-allow
echo "Built: $SCRIPT_DIR/markus-chrome-allow"
