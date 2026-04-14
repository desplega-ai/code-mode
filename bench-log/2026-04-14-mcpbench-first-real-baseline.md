---
date: 2026-04-14
external_bench: mcp-bench (Accenture)
models: [claude-sonnet-4-6 via claude-code-baseline]
variants: [claude-code-baseline]
tasks: [wikipedia_000]
total_runs: 1
total_cost_usd: ~0.62
status: first-real-judge-scores
related:
  - bench-log/2026-04-14-mcpbench-wiring-fixes.md
  - bench/external/mcp-bench-adapter/
---

# 2026-04-14 — MCP-Bench first real end-to-end: claude-code-baseline, 1 task

Third run of the day on the external bench. First one that produces actual
judge scores instead of zeros or rate-limit errors. Proves the whole adapter
chain (executor → stream parser → judge dict shape → OpenAI judge) works
end-to-end.

## What ran

```bash
cd ~/Documents/code/misc/mcp-bench && source .venv/bin/activate && source .env.smoke
env -u VIRTUAL_ENV CLAUDE_CODE_KEEP_WORKDIR=1 \
  PATH="/Users/taras/.local/bin:/Users/taras/.nvm/versions/node/v24.14.1/bin:$PATH" \
  python run_benchmark.py --models claude-code-baseline \
    --tasks-file tasks/_smoke1.json --distraction-count 0
```

- Task: `wikipedia_000` (from `tasks/_smoke1.json`; one of the single-server Wikipedia tasks from MCP-Bench's standard suite).
- Variant: `claude-code-baseline` — bare Claude Code, `.mcp.json` declares Wikipedia MCP only, code-mode plugin NOT loaded.
- Model: `claude-sonnet-4-6`.
- Judge: `gpt-5.4-mini` via OpenAI (patched via `judge-openai.patch` + provider `max_completion_tokens` fix).
- Retries: 0. One clean attempt.

## Headline numbers

| Dimension (judge, 0–5) | Score |
|---|---|
| task_completion_score | **4.7** |
| tool_selection_score | **4.8** |
| planning_effectiveness_and_efficiency_score | 4.4 |
| task_fulfillment | 4.4 |
| grounding | 5.0 |
| tool_appropriateness | 5.2 |
| task_success_rate | 1.0 (1/1) |

| Telemetry | Value |
|---|---|
| agent wall time | 294 s (~4m54s) |
| judge eval time | 49 s |
| rounds | 28 |
| tool_use calls | 20 |
| Claude Code cost | **$0.60** |
| judge cost | ~$0.02–0.05 (gpt-5.4-mini, cheap) |
| cache_read tokens | 769,640 |
| cache_creation tokens | 201,463 |
| new input tokens | 44 |
| output tokens | 201 |

Raw: `/var/folders/.../mcpbench-claude-3wfxrr5v/_stream.jsonl` (preserved via `CLAUDE_CODE_KEEP_WORKDIR=1`).

## Tool mix (baseline)

Direct Wikipedia MCP usage — no code-mode tools, no WebFetch fallback.

- `mcp__Wikipedia__get_summary`: 9
- `mcp__Wikipedia__get_links`: 5
- `mcp__Wikipedia__search_wikipedia`: 1
- `mcp__Wikipedia__summarize_article_for_query`: 1
- `mcp__Wikipedia__extract_key_facts`: 1
- `mcp__Wikipedia__get_related_topics`: 1
- `ToolSearch`: 1
- `Write`: 1 (produced `climate_frameworks.json` artifact)

## Tells us

- **Adapter is fully wired and verifiable against an external public bench.** Every wiring bug from the earlier sessions (ANTHROPIC_API_KEY, HOME override, .mcp.json shape, VIRTUAL_ENV leak, per-server venv binding, judge `max_completion_tokens`) is now fixed end-to-end.
- **Baseline (Claude Code Sonnet 4.6) on Wikipedia scores very high (4.4–5.2).** The Wikipedia task is well within Sonnet's comfort zone — bath water here is hot. Reading too much into this is premature.
- **Cost per task is ~$0.60** and **~5 min wall time**, dominated by cache-read (769k tokens) because Sonnet streams the whole prompt across each of the 28 rounds. A full single-server file sweep × 2 variants × N=1 projects to **~$70 + 6 hours of wall time**. Meaningful but not prohibitive.
- **Default `CLAUDE_CODE_TIMEOUT_S=300` was too tight** — this run hit 294s, so the previous one with the same task timed out and death-looped on retries. Bumped to `900` in `.env.smoke`. Should bake that into the executor default next.
- **`tool_call_success_rate: 0.0`** — cosmetic: MCP-Bench computes this from a `success` flag on each `execution_results` entry, which our stream parser doesn't populate. Judge scoring isn't affected; easy follow-up to fix alongside the timeout default.

## Next steps

1. **Block variant on the same task (priority).** Run `claude-code-codemode-block` on `wikipedia_000` alone (`--models claude-code-codemode-block --tasks-file tasks/_smoke1.json`) to prove the variant completes at all with the current adapter, then compare against baseline. Needs `CODE_MODE_PLUGIN_DIR=/Users/taras/Documents/code/code-mode/plugins/code-mode` in the env — already in `.env.smoke`. First thing to verify in the next session.
2. **Bake fixes into the committed adapter**: bump `CLAUDE_CODE_TIMEOUT_S` default to 900 in `claude_code_executor.py`, populate `success` flag in `execution_results`, amend `provider.py` patch for `max_completion_tokens` (currently only in the local fork, not in `bench/external/mcp-bench-adapter/`).
3. **Full 5-task smoke** (baseline + block). Only after step 1 proves block runs end-to-end. Use `tasks/_smoke5.json` (already in the fork, 5 key-free servers).
4. **Bench log it + commit**. Always write a bench-log entry per real run per `CLAUDE.md`.

## Cost ledger (this session)

- Today's runs total: 3 × ~$0.60 agent = ~$1.80 agent + ~$0.10 judge ≈ **$1.90** for all three.
- Plus the Opus multi-MCP sweep earlier (~$1.20 from the other bench-log entry).
- Session total: **~$3.10**.
