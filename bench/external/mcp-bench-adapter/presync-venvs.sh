#!/usr/bin/env bash
# Pre-create per-server `.venv` directories under mcp_servers/*/ so Claude
# Code's MCP stdio spawn can hard-bind `.venv/bin/python` (see the
# `local_py` branch in claude_code_executor._build_mcp_json). MCP-Bench's
# own install.sh does NOT create these — it assumes the upstream runner
# activates a conda env once and runs everything inside it, which doesn't
# translate to Claude Code's per-MCP subprocess spawn model.
#
# Run from the mcp-bench repo root AFTER install.sh:
#   bash /path/to/code-mode/bench/external/mcp-bench-adapter/presync-venvs.sh
#
# Idempotent: uv sync is a no-op if the lockfile already matches the venv.

set -e
cd "${1:-$(pwd)}/mcp_servers" || { echo "run from mcp-bench root"; exit 1; }
echo "presync-venvs: scanning $(pwd) for python MCP servers…"
count=0
for d in */; do
  [ -f "${d}pyproject.toml" ] || continue
  [ -f "${d}uv.lock" ] || continue
  echo "  [sync] ${d%/}"
  (cd "$d" && uv sync --quiet) || echo "  [warn] uv sync failed for $d — server may not start"
  count=$((count + 1))
done
echo "presync-venvs: $count server venvs synced."
