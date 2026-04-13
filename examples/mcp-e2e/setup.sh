#!/usr/bin/env bash
# Prepares a .code-mode/ workspace with a saved `hello` script so the MCP
# E2E test below has something meaningful to search for and run.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WS="$HERE/workspace"

# Fresh workspace every run.
rm -rf "$WS"
mkdir -p "$WS"
cd "$WS"

# Use the published package via npx so we're testing what users get.
# Needs bun or npm on PATH — the CLI auto-detects.
npx -y @desplega/code-mode@latest init

# Seed a script the agent can find via `search` + execute via `run`.
cat > /tmp/code-mode-e2e-hello.ts <<'TS'
/**
 * @name greet
 * @description Returns a friendly greeting for a given name.
 * @tags example, e2e, greeting
 */
export async function main(args: { name: string }): Promise<{ greeting: string }> {
  return { greeting: `hello, ${args.name}` };
}
TS

npx -y @desplega/code-mode@latest save greet --file /tmp/code-mode-e2e-hello.ts --overwrite

# `init` scaffolds stdlib *files* but doesn't auto-reindex; `save` only
# indexed the script we just added. Reindex explicitly so list_sdks /
# query_types have something to return for the E2E.
npx -y @desplega/code-mode@latest reindex --no-sdk-gen

echo ""
echo "[setup] workspace ready at: $WS"
echo "[setup] run ./run.sh to launch claude -p with the MCP server attached."
