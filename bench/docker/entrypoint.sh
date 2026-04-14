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

PLUGIN_ARGS=""

case "$BENCH_VARIANT" in
  baseline)
    printf '{}\n' > "$HOME/.claude/settings.json"
    ;;
  code-mode-generic|code-mode-tailored)
    if [ -d /workspace/.code-mode ]; then
      # Persistent workdir (session 2+): workspace already initialised.
      # Re-index in case anything on disk changed between sessions.
      (cd /workspace && code-mode reindex >/dev/null) || true
    else
      code-mode init /workspace >/dev/null
      if [ -d /seeds ]; then
        # Copy seed scripts into the code-mode workspace, then reindex so the
        # SQLite FTS picks them up (init only indexed the empty scripts dir).
        find /seeds -maxdepth 1 -type f -name '*.ts' -exec cp {} /workspace/.code-mode/scripts/ \;
        (cd /workspace && code-mode reindex >/dev/null)
      fi
    fi
    cat > /workspace/.mcp.json <<'JSON'
{"mcpServers":{"code-mode":{"command":"code-mode","args":["mcp"]}}}
JSON
    cat > "$HOME/.claude/settings.json" <<'JSON'
{"enableAllProjectMcpServers":true,"enabledMcpjsonServers":["code-mode"]}
JSON
    ;;
  code-mode-plugin|code-mode-subagent)
    # Workspace is seeded the same way as `code-mode-tailored` (so __search
    # finds tailored scripts). The differentiator is that MCP + hooks +
    # sub-agent come from the mounted plugin at /plugin/code-mode via
    # `--plugin-dir`, not from `.mcp.json`.
    if [ -d /workspace/.code-mode ]; then
      (cd /workspace && code-mode reindex >/dev/null) || true
    else
      code-mode init /workspace >/dev/null
      if [ -d /seeds ]; then
        find /seeds -maxdepth 1 -type f -name '*.ts' -exec cp {} /workspace/.code-mode/scripts/ \;
        (cd /workspace && code-mode reindex >/dev/null)
      fi
    fi

    if [ ! -f /plugin/code-mode/.claude-plugin/plugin.json ]; then
      echo "entrypoint: /plugin/code-mode mount missing plugin.json manifest" >&2
      exit 2
    fi

    # `--plugin-dir` expects the directory *containing* plugin folders.
    # The plugin's own plugin.json registers the MCP server, SessionStart
    # routing hook, PreToolUse hints, and the scripter sub-agent.
    PLUGIN_ARGS="--plugin-dir /plugin"

    # Empty settings — the plugin carries hooks/MCP via its own manifest.
    printf '{}\n' > "$HOME/.claude/settings.json"

    if [ "$BENCH_VARIANT" = "code-mode-subagent" ]; then
      if [ ! -f /plugin/code-mode/agents/scripter.md ]; then
        echo "entrypoint: scripter.md missing at /plugin/code-mode/agents/scripter.md" >&2
        exit 2
      fi
    fi
    ;;
  *)
    echo "entrypoint: unknown BENCH_VARIANT: $BENCH_VARIANT" >&2
    exit 2
    ;;
esac

# shellcheck disable=SC2086  # PLUGIN_ARGS is intentionally word-split.
if [ -n "${BENCH_MODEL:-}" ]; then
  exec claude --dangerously-skip-permissions \
    --output-format stream-json --verbose \
    --model "$BENCH_MODEL" \
    $PLUGIN_ARGS \
    -p "$BENCH_PROMPT"
else
  exec claude --dangerously-skip-permissions \
    --output-format stream-json --verbose \
    $PLUGIN_ARGS \
    -p "$BENCH_PROMPT"
fi
