---
date: 2026-04-14
external_bench: mcp-bench (Accenture)
models: [claude-sonnet-4-6 via claude-code-baseline]
variants: [claude-code-baseline]
tasks: [wikipedia_000]
status: wiring-verified / rate-limited
related:
  - bench-log/2026-04-14-mcpbench-smoke-blocked.md
  - bench/external/mcp-bench-adapter/
---

# 2026-04-14 — MCP-Bench adapter wiring fixes

Second pass after the first smoke got blocked on API usage cap. Five distinct issues surfaced and got fixed along the way; documenting them so the next person (or me after the rate limit lifts) doesn't rediscover them.

## Issues fixed

1. **`ANTHROPIC_API_KEY` wins over OAuth.** When the env has both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, Claude Code silently prefers the API key path — which has separate (often lower) usage caps. Fix: `child_env.pop("ANTHROPIC_API_KEY", None)` in the executor before spawning. **Any adapter that spawns `claude -p` as a subprocess needs this.**

2. **`HOME=workdir` breaks child MCP servers.** We were setting `HOME` to a tmp workdir so Claude would load our scoped `.claude/settings.json`. But every child uv/pip/npm MCP server reads `$HOME/.cache/...` for its own state; a fresh HOME makes uv think the machine is empty and try to re-fetch Python 3.10 from scratch, which busts Claude Code's MCP handshake timeout. Fix: drop `HOME` override entirely. Use `--mcp-config <file> --settings <file> --strict-mcp-config` instead — Claude Code will load only the scoped files without any HOME games.

3. **Wrong `.mcp.json` shape.** Our `_build_mcp_json` was reading raw `commands.json` fields (`cmd: str`, `env: [keynames]`, relative `cwd: ../foo`). The runner passes the *normalized* shape (`command: list[str]`, `env: populated dict`, `cwd: mcp_servers/<dir>`). Fixed in executor.

4. **`VIRTUAL_ENV` leaks into child MCP subprocesses.** Even with the narrow env we pass in `.mcp.json`, if the parent shell has `source .venv/bin/activate`'d the harness venv, Claude Code inherits `VIRTUAL_ENV` from its own parent. When the MCP spawn reaches `uv run python -m wikipedia_mcp`, uv's `--active`-ish behaviour respects that env var and runs the harness venv's `python3`, which doesn't have `wikipedia_mcp` installed. Fix: (a) strip `VIRTUAL_ENV` + harness `.venv/bin` from the child env we hand to Claude, (b) hard-bind each python MCP server to its own `<cwd>/.venv/bin/python` absolute path — bypassing uv's project resolution entirely.

5. **Per-server `.venv` dirs don't exist after `install.sh`.** MCP-Bench's installer assumes conda is pre-activated and installs everything into the single ambient env. Our executor hard-binds to `<cwd>/.venv/bin/python`, which requires each server to have its own venv. Fix: `presync-venvs.sh` walks `mcp_servers/*/`, runs `uv sync` per directory. Landed under `bench/external/mcp-bench-adapter/presync-venvs.sh`. 10/28 servers sync cleanly; a few (notably huggingface-mcp) fail because `pydantic-core` can't build under python 3.14 host — those weren't in our 5-task smoke anyway.

## Verification (without LLM calls)

Used `claude --debug-file /tmp/log.log --mcp-config /tmp/_mcptest4.json --strict-mcp-config -p "x"` with the full fix chain applied. Debug log shows:

```
[DEBUG] MCP server "Wikipedia": Successfully connected (transport: stdio) in 875ms
[DEBUG] MCP server "Wikipedia": Connection established with capabilities:
        {"hasTools":true,"hasPrompts":true,...}
[DEBUG] MCP server "Time_MCP": Successfully connected (transport: stdio) in 1422ms
```

Both MCPs that were previously `status: failed` in the `system init` event now connect. The LLM call itself hits the Sonnet quota ("resets 7pm Europe/Madrid") so we can't end-to-end the agent loop yet, but everything up to "Claude starts planning" is proven.

## Still blocked

Taras's Claude Code Sonnet quota resets ~19:00 Europe/Madrid today (2026-04-14). Once lifted, rerun:

```bash
cd ~/Documents/code/misc/mcp-bench && source .venv/bin/activate && source .env.smoke
JUDGE_MODEL=gpt-5.4-mini CLAUDE_CODE_KEEP_WORKDIR=1 \
  python run_benchmark.py --models claude-code-baseline \
    --tasks-file tasks/_smoke1.json --distraction-count 0
```

And check the per-task `_parsed.json` dump in the preserved workdir for: real tool_use counts for `mcp__Wikipedia__*`, non-zero token usage, and non-zero judge scores.

## Cost

~$0 for the wiring work — everything hit the rate limit before spending any real inference budget.
