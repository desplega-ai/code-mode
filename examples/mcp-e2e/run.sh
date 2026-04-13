#!/usr/bin/env bash
# Runs the MCP E2E: launches `claude -p` with only the `code-mode` MCP
# server attached, and pipes in the test prompt. No other tools allowed,
# so the only way Claude can answer is via the MCP server.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if [ ! -d "workspace/.code-mode" ]; then
  echo "[run] workspace not initialized — running setup.sh first…"
  "$HERE/setup.sh"
fi

claude -p \
  --model sonnet \
  --mcp-config "$HERE/mcp-config.json" \
  --mcp-debug \
  --allowed-tools "mcp__code-mode__search,mcp__code-mode__list_sdks,mcp__code-mode__query_types,mcp__code-mode__run,mcp__code-mode__save" \
  < "$HERE/prompt.md"
