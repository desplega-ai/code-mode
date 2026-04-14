---
date: 2026-04-14
models: [claude-opus-4-6]
variants: [multi-mcp-baseline, multi-mcp-codemode, multi-mcp-block]
tasks: [multi-mcp-upsert]
reps: 3
total_runs: 9
total_cost_usd: ~1.20
related:
  - thoughts/taras/research/2026-04-14-multi-mcp-findings.md
  - thoughts/taras/research/2026-04-14-external-benches-survey.md
  - bench/external/mcp-bench-adapter/
---

# 2026-04-14 — Opus multi-MCP sweep + MCP-Bench adapter cut-1

## Run 1 — Opus multi-MCP, N=3

**Command**:
```bash
bun run bench --tasks tasks/multi-mcp-upsert \
  --variants multi-mcp-baseline,multi-mcp-codemode,multi-mcp-block \
  --models opus --reps 3 --concurrency 2 \
  --out results/opus-multimcp-n3
```

**Raw**: `bench/results/opus-multimcp-n3/` (report.md, report.json, run.log committed; raw stream-json under `raw/` is gitignored).

| Variant | Cost (median) | Tokens (median) | Tool calls | Wall (median) | Δ cost |
|---|---|---|---|---|---|
| `multi-mcp-baseline` | $0.1436 | 398,669 | 7.0 | 52.8 s | — |
| `multi-mcp-codemode` (hint) | **$0.0808** | 301,491 | 5.0 | 69.0 s | **−44%** |
| `multi-mcp-block` | $0.1805 | 670,335 | 12.0 | 105.9 s | +26% |

All 9 runs `smoke_pass=true`.

**Tells us**:
- Hint-mode signal **holds on Opus and is *bigger*** than on Sonnet (−44% vs −19–30%). Confirms the cross-model claim that was open in `multi-mcp-findings.md`.
- Block remains net-negative on Opus (+26% cost), same shape as on Sonnet — block is for safety/auditing, not for performance.
- Opus never autonomously called `mcp__code-mode__*` in any hint-mode run, mirroring Sonnet behaviour. The win is *entirely* SessionStart-text-driven steering away from speculative `ToolSearch`.

## Run 2 — MCP-Bench adapter (cut-1, no E2E yet)

Track A scaffold landed at `bench/external/mcp-bench-adapter/`:
- `claude_code_executor.py` — drop-in twin of MCP-Bench's `TaskExecutor`. Builds a `.mcp.json` from `server_manager.server_configs`, spawns `claude -p`, parses stream-json into the dict shape MCP-Bench's judge consumes.
- `claude_code_provider.py` — sentinel `LLMProvider` for `isinstance()` detection in the runner branch.
- `upstream.patch` — 2-hunk patch to `llm/factory.py` + `benchmark/runner.py` adding the `claude-code-baseline` and `claude-code-codemode-block` model entries.

**Tells us**:
- Plug-in is at the executor level (Claude IS the agent), not the LLM level — wiring `claude -p` as a "completion provider" would have caused a double-loop with Claude doing one tool-loop and MCP-Bench's `TaskExecutor` doing another, and Claude would never have actually used MCPs.
- Unit-smoked the `.mcp.json` builder + stream parser; no E2E run yet (needs MCP-Bench's `mcp_servers/install.sh` ~10 min + Azure OpenAI key for the o4-mini judge).

## Cost ledger

- Opus N=3 sweep: ~$1.20 (3× ~$0.40 per variant median).
- Adapter dev: $0 (no SDK calls, only local edits + unit smoke).
