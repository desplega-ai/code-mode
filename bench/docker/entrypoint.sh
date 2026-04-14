#!/bin/sh
# Variant-aware setup for a single Claude Code benchmark run.
# Reads: BENCH_VARIANT, BENCH_PROMPT, CLAUDE_CODE_OAUTH_TOKEN.
set -e

: "${BENCH_VARIANT:?BENCH_VARIANT is required}"
: "${BENCH_PROMPT:?BENCH_PROMPT is required}"
: "${CLAUDE_CODE_OAUTH_TOKEN:?CLAUDE_CODE_OAUTH_TOKEN is required}"

printf '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}\n' \
  > "$HOME/.claude.json"
mkdir -p "$HOME/.claude"

case "$BENCH_VARIANT" in
  baseline)
    printf '{}\n' > "$HOME/.claude/settings.json"
    ;;
  code-mode-generic|code-mode-tailored)
    code-mode init /workspace >/dev/null
    if [ -d /seeds ]; then
      # Copy seed scripts into the code-mode workspace, then reindex so the
      # SQLite FTS picks them up (init only indexed the empty scripts dir).
      find /seeds -maxdepth 1 -type f -name '*.ts' -exec cp {} /workspace/.code-mode/scripts/ \;
      (cd /workspace && code-mode reindex >/dev/null)
    fi
    cat > /workspace/.mcp.json <<'JSON'
{"mcpServers":{"code-mode":{"command":"code-mode","args":["mcp"]}}}
JSON
    cat > "$HOME/.claude/settings.json" <<'JSON'
{"enableAllProjectMcpServers":true,"enabledMcpjsonServers":["code-mode"]}
JSON
    ;;
  *)
    echo "entrypoint: unknown BENCH_VARIANT: $BENCH_VARIANT" >&2
    exit 2
    ;;
esac

if [ -n "${BENCH_MODEL:-}" ]; then
  exec claude --dangerously-skip-permissions \
    --output-format stream-json --verbose \
    --model "$BENCH_MODEL" \
    -p "$BENCH_PROMPT"
else
  exec claude --dangerously-skip-permissions \
    --output-format stream-json --verbose \
    -p "$BENCH_PROMPT"
fi
