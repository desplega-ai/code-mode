---
date: 2026-04-14
external_bench: mcp-bench (Accenture)
models: [claude-sonnet-4-6 via claude-code-baseline]
variants: [claude-code-baseline]
tasks: [unit_converter_000, wikipedia_000, call_for_papers_000, context7_000, fruityvice_000]
total_runs: 5
total_cost_usd: ~0
status: blocked
related:
  - bench/external/mcp-bench-adapter/
  - bench-log/2026-04-14-opus-multimcp-track-a.md
---

# 2026-04-14 — MCP-Bench smoke (blocked on API limit)

## What ran

```bash
cd ~/Documents/code/misc/mcp-bench && source .venv/bin/activate && source .env.smoke
JUDGE_MODEL=gpt-5-mini python run_benchmark.py \
  --models claude-code-baseline \
  --tasks-file tasks/_smoke5.json \
  --distraction-count 0 --verbose
```

5 single-server tasks chosen for key-free MCPs: Unit Converter, Wikipedia, Call for Papers, Context7, FruityVice. Adapter scaffold from `bench/external/mcp-bench-adapter/` was dropped into a fresh fork at `~/Documents/code/misc/mcp-bench` and judge swapped to OpenAI gpt-5-mini.

## Result: blocked

MCP-Bench reported `task_success_rate=0.8` (4/5 "ok") but every single judge dimension scored `0.0`. Reason: each task's Claude Code subprocess ran for ~1.6 s and returned this string as its "answer":

> `API Error: 400 ... "You have reached your specified API usage limits. You will regain access on 2026-05-01 at 00:00 UTC."`

So no actual agent work happened. Self-imposed monthly cap on the OAuth token. Earlier sessions today (Opus N=3 multi-MCP sweep at 13:58, ~$1.20) had landed before the cap kicked in.

## Tells us

- **Adapter wiring works**: subprocess spawns, .mcp.json is generated correctly, stream-json parser handles the error path, results flow into MCP-Bench's judge dict shape, judge reads them.
- **3 upstream / cut-1 bugs found and fixed**: (1) `commands_config` referenced unconditionally but only loaded when distractions enabled — patched into `mcpbench-bugfix.patch`. (2) Our `_build_mcp_json` was reading raw `commands.json` shape; the runner passes the *normalized* shape (`command: list`, `env: populated dict`, `cwd: 'mcp_servers/...'`) — fixed in executor. (3) `judge-openai.patch` added so judge can run on regular OpenAI with parameterizable `JUDGE_MODEL`.
- **Wikipedia MCP fails inside Claude Code's MCP client too** (`mcp_servers:[{name:Wikipedia, status:failed}]`). Likely FastMCP's banner-print on stdio corrupts the handshake. Won't matter until we can actually run agents — flag as a follow-up.
- **One-shot install path validated end-to-end** (uv venv 3.10 + `mcp_servers/install.sh` + `npm i -g` for claude+code-mode). ~30 min total.

## Next

Wait for API cap to lift on 2026-05-01 (or use a token with more headroom), then re-run the 5-task smoke. Once that produces real judge scores, scale to 2-variant comparison (baseline vs codemode-block).

## Cost

~$0 — every claude run was a 1.6 s 400-error rejection (no tokens billed). Judge calls to OpenAI: ~5 × ~3k tokens = ~$0.05.
