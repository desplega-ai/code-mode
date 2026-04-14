---
date: 2026-04-14
external_bench: mcp-bench (Accenture)
models: [claude-sonnet-4-6 via claude-code-codemode-block]
variants: [claude-code-codemode-block]
tasks: [wikipedia_000]
total_runs: 1
total_cost_usd: ~0.83
status: block-variant-working-end-to-end
related:
  - bench-log/2026-04-14-mcpbench-first-real-baseline.md
  - bench-log/2026-04-14-mcpbench-block-broken.md
  - plugins/code-mode/hooks/
---

# 2026-04-14 — MCP-Bench block variant: end-to-end after self-denial fix

Rerun of the block variant on the same task
(`wikipedia_000`, `claude-sonnet-4-6`) after fixing the code-mode plugin
hook's self-denial bug. The variant now completes end-to-end, routes
through `mcp__code-mode__run` as designed, and scores within range of
baseline. Third bench-log entry for this task; see
`2026-04-14-mcpbench-block-broken.md` for the prior failure and the full
root-cause writeup.

## What ran

Same command as the broken run — the fix is in the plugin hook, not the
invocation:

```bash
cd ~/Documents/code/misc/mcp-bench && source .venv/bin/activate && source .env.smoke
env -u VIRTUAL_ENV CLAUDE_CODE_KEEP_WORKDIR=1 \
  PATH="/Users/taras/.local/bin:/Users/taras/.nvm/versions/node/v24.14.1/bin:$PATH" \
  python run_benchmark.py --models claude-code-codemode-block \
    --tasks-file tasks/_smoke1.json --distraction-count 0
```

- Fix picked up via `CODE_MODE_PLUGIN_DIR` → `plugins/code-mode/` in the
  code-mode repo (mounted live into the bench workspace). Commit: `db1703a`.
- Raw: `/var/folders/nk/.../T/mcpbench-claude-0gjkoyr7/_stream.jsonl`.

## The fix (summary)

The hook hardcoded `mcp__plugin_code-mode_` as the self-exemption prefix
(and used that form in every hint/deny message). But the bench adapter
wires code-mode via `.mcp.json`, which makes Claude Code register its
tools as `mcp__code-mode__*` — no `plugin_` infix. The exemption never
matched, so the hook denied its own `mcp__code-mode__run` and recommended
a plugin-prefixed name that didn't exist. The agent had no escape hatch
and fell back to Bash/REST.

Fix replaces the hardcoded prefix with:

- `CODE_MODE_SELF_TOOL_RE = /^mcp__(?:plugin_code-mode_)?code-mode__/` —
  matches both shapes, applied identically in `_shared.mjs` and
  `packages/core/src/workspace/config.ts` (drift parity test covers both).
- `codeModeToolPrefix(hintToolName, cwd)` helper picks the runtime-correct
  form for every hint/deny message, with precedence:
  1. Infer from `hintToolName` shape (same session uses one form uniformly).
  2. Probe `${cwd}/.mcp.json` for a `code-mode` entry.
  3. Fall back to `CLAUDE_PLUGIN_ROOT` env presence.
  4. Default to bare form.

All six message templates in `_shared.mjs` + `sessionstart.mjs` route
through this helper. Tests: `bun test packages/core/test/plugin` +
`test/workspace` → 51 pass / 0 fail.

## Headline numbers

Three-way side-by-side with the two prior runs on this task:

| Dimension (judge, 0–5)        | baseline | block-broken | **block-fixed** | Δ vs base |
|-------------------------------|----------|--------------|-----------------|-----------|
| task_completion_score         | 4.7      | 1.8          | **4.0**         | −0.7      |
| tool_selection_score          | 4.8      | 2.7          | **5.2**         | **+0.4**  |
| planning_effectiveness_score  | 4.4      | 1.9          | **3.6**         | −0.8      |
| task_fulfillment              | 4.4      | 1.8          | **3.6**         | −0.8      |
| grounding                     | 5.0      | 1.8          | **4.4**         | −0.6      |
| tool_appropriateness          | 5.2      | 3.4          | **5.6**         | **+0.4**  |
| parameter_accuracy            | —        | 2.0          | 4.8             | —         |
| dependency_awareness          | —        | 2.0          | 4.0             | —         |
| parallelism_efficiency        | —        | 1.8          | 3.2             | —         |
| task_success_rate             | 1.0      | 1.0          | 1.0             | =         |

| Telemetry                 | baseline | block-broken | **block-fixed** |
|---------------------------|----------|--------------|-----------------|
| agent wall time           | 294 s    | 217 s        | **304 s**       |
| judge eval time           | 49 s     | 37 s         | 41 s            |
| MCP-Bench rounds          | 28       | 31           | **56**          |
| tool_use calls            | 20       | 15           | **30**          |
| Claude Code cost          | $0.60    | $0.45        | **$0.83**       |
| cache_read tokens         | 769 k    | 352 k        | **1,116 k**     |
| cache_creation tokens     | 201 k    | 44 k         | 69 k            |
| output tokens (SDK)       | 201      | 12,056       | 15,826          |
| hook denials              | 0        | 5            | **4** ✓         |

The 4 denials in the fixed run are all on the Wikipedia MCP (the four
direct `mcp__Wikipedia__*` calls that the block mode is *supposed* to
deny). Zero self-denials on `mcp__code-mode__*`. That's the correct
shape.

## Tool mix (block-fixed)

```
mcp__code-mode__run                   7   ← was 1 call, denied
mcp__code-mode__search                2
mcp__code-mode__query_types           2
mcp__code-mode__save                  2
mcp__code-mode__list_sdks             1
mcp__Wikipedia__search_wikipedia      1   denied (correct)
mcp__Wikipedia__summarize_article…    1   denied (correct)
mcp__Wikipedia__extract_key_facts     1   denied (correct)
mcp__Wikipedia__get_related_topics    1   denied (correct)
Glob                                  4
Read                                  3
Write                                 3
ToolSearch                            1
Edit                                  1
```

The agent:

1. Tried the four Wikipedia MCP tools directly → hook denied them with
   messages pointing at `mcp__code-mode__run` + a typed snippet.
2. Called `mcp__code-mode__list_sdks` / `query_types` / `search` to
   introspect the typed SDKs code-mode had auto-generated for Wikipedia.
3. Ran a multi-tool workflow through `mcp__code-mode__run` seven times
   (initial scripts + refinements), saved two reusable scripts via
   `__save`, and used Glob/Read/Write to persist intermediate JSON.
4. Produced the final `climate_frameworks.json` artifact with grounded
   content from successful SDK calls.

This is exactly the code-mode routing story the plugin exists to prove.

## Tells us

- **Fix is real, bug is dead.** The block variant runs end-to-end on an
  external public bench and routes through the plugin's typed SDK the
  way the design intended. Judge scores jumped by +2.2 / +2.5 / +1.7 on
  the three headline dimensions.
- **Block variant ≈ baseline on quality, but costs +38% and takes ~2×
  the rounds** (56 vs 28) and **~1.5× the tool calls** (30 vs 20). For a
  task that's entirely inside Sonnet's comfort zone with a single
  well-documented MCP, the code-mode indirection is overhead, not
  leverage. The interesting question is where the ratio flips — almost
  certainly a multi-MCP task with cross-server data joins, not a
  single-Wikipedia lookup. That's the `_smoke5.json` run next.
- **Tool-selection and tool-appropriateness beat baseline** (5.2 > 4.8,
  5.6 > 5.2). The judge rewards "used the right kind of tool" and
  routing through a typed SDK scores better on that axis than raw MCP
  calls, even when the underlying work is the same. Small-sample
  finding, shouldn't overclaim.
- **Grounding is still the weak spot** (4.4 vs 5.0 baseline). The agent
  made some claims that weren't traceable to successful tool outputs —
  the judge flagged specific cases. Worth watching across `_smoke5`.
- **`tool_call_success_rate` is still pinned at 0.00%** — the
  `success`-flag fix is in the committed adapter
  (`bench/external/mcp-bench-adapter/claude_code_executor.py`) but NOT
  in the fork's `agent/claude_code_executor.py` that actually runs, and
  the rerun used the fork. Cosmetic, judge scores aren't affected.
  Propagate on next session.

## Next steps

1. **Propagate the adapter fixes to the fork**
   (`~/Documents/code/misc/mcp-bench/agent/claude_code_executor.py`):
   the `success`-flag pairing + the 900s timeout default. Both are in
   `bench/external/mcp-bench-adapter/claude_code_executor.py` on `main`
   already — just need to sync into the fork before the next run.
2. **`_smoke5.json` run, both variants.** Now that block works end-to-end,
   this is the first MCP-Bench result that actually measures the code-mode
   thesis: multi-MCP tasks where typed-SDK routing + stdlib helpers
   should outweigh the per-task overhead. Baseline + block, same task
   set, same model, compare deltas.
3. **Propagate `llm/provider.py` `max_completion_tokens` patch** into
   the committed adapter (still only in the fork). Unchanged from the
   prior logs; still not blocking anything.

## Cost ledger (this session)

- Block rerun: $0.83 agent + ~$0.02 judge = **~$0.85**.
- Today's bench-run total:
  - Baseline (wikipedia_000): ~$0.62
  - Block broken (wikipedia_000): ~$0.47
  - Block fixed (wikipedia_000): ~$0.85
  - Earlier Opus multi-MCP sweep (per `ae1934a` entry): ~$1.20
  - Session running total: **~$3.14 agent + ~$0.80 judge ≈ $3.94**
