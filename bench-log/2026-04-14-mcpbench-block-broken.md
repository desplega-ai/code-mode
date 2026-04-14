---
date: 2026-04-14
external_bench: mcp-bench (Accenture)
models: [claude-sonnet-4-6 via claude-code-codemode-block]
variants: [claude-code-codemode-block]
tasks: [wikipedia_000]
total_runs: 1
total_cost_usd: ~0.45
status: negative-result-block-hook-bug
related:
  - bench-log/2026-04-14-mcpbench-first-real-baseline.md
  - plugins/code-mode/
---

# 2026-04-14 — MCP-Bench block variant: broken by self-denial bug

Counterpart to the baseline run. Same task (`wikipedia_000`), same model
(`claude-sonnet-4-6`), same Wikipedia-only MCP stack, but with the `@desplega/code-mode`
plugin loaded in BLOCK mode. Exposes a real bug in the block hook and serves as
the first honest negative result we have from the external bench.

## What ran

```bash
cd ~/Documents/code/misc/mcp-bench && source .venv/bin/activate && source .env.smoke
env -u VIRTUAL_ENV CLAUDE_CODE_KEEP_WORKDIR=1 \
  PATH="/Users/taras/.local/bin:/Users/taras/.nvm/versions/node/v24.14.1/bin:$PATH" \
  python run_benchmark.py --models claude-code-codemode-block \
    --tasks-file tasks/_smoke1.json --distraction-count 0
```

- Variant: `claude-code-codemode-block` — `CODE_MODE_PLUGIN_DIR` points at the
  local plugin, `CODE_MODE_MCP_BLOCK=1` (via the variant), `.mcp.json` declares
  the same Wikipedia MCP the baseline run uses.
- Judge: `gpt-5.4-mini` via OpenAI (same path as the baseline).
- Retries: 0. One clean attempt, judged without any rate-limit errors.
- Raw: `/var/folders/nk/.../T/mcpbench-claude-eq1tl3ca/_stream.jsonl`
  (preserved via `CLAUDE_CODE_KEEP_WORKDIR=1`).

## Headline numbers

Side-by-side with the baseline from
`2026-04-14-mcpbench-first-real-baseline.md`:

| Dimension (judge, 0–5)        | baseline | **block** | Δ     |
|-------------------------------|----------|-----------|-------|
| task_completion_score         | 4.7      | **1.8**   | −2.9  |
| tool_selection_score          | 4.8      | **2.7**   | −2.1  |
| planning_effectiveness_score  | 4.4      | **1.9**   | −2.5  |
| task_fulfillment              | 4.4      | 1.8       | −2.6  |
| grounding                     | 5.0      | 1.8       | −3.2  |
| tool_appropriateness          | 5.2      | 3.4       | −1.8  |
| parameter_accuracy            | —        | 2.0       | —     |
| dependency_awareness          | —        | 2.0       | —     |
| parallelism_efficiency        | —        | 1.8       | —     |
| task_success_rate             | 1.0      | 1.0 *     | =     |
| tool_call_success_rate        | 0.0 †    | 0.0 †     | =     |

\* `task_success_rate` is derived from "did the run complete without a
harness-level error?"; it does *not* reflect that the agent failed to actually
answer the task. The judge scores above are the honest signal.
† Cosmetic — our stream parser still doesn't populate the per-call `success`
flag; MCP-Bench computes 0.0 for everyone.

| Telemetry                 | baseline   | **block**  | Δ       |
|---------------------------|------------|------------|---------|
| agent wall time           | 294 s      | **217 s**  | −77 s   |
| judge eval time           | 49 s       | 37 s       | −12 s   |
| MCP-Bench rounds          | 28         | **31**     | +3      |
| tool_use calls            | 20         | **15**     | −5      |
| Claude Code cost          | **$0.60**  | **$0.45**  | −$0.15  |
| cache_read tokens         | 769,640    | 351,880    | −417k   |
| cache_creation tokens     | 201,463    | 43,786     | −157k   |
| output tokens (SDK)       | 201        | 12,056     | +11,855 |

Cheaper not because it's more efficient — cheaper because it gave up earlier
and generated a hallucinated final answer instead of looping through real tool
calls.

## Tool mix (block)

```
ToolSearch                            5   (searching for the plugin-prefixed SDK)
Bash                                  3   (raw Wikipedia REST fallback — all failed)
mcp__Wikipedia__search_wikipedia      1   denied
mcp__Wikipedia__summarize_article…    1   denied
mcp__Wikipedia__extract_key_facts     1   denied
mcp__Wikipedia__get_related_topics    1   denied
mcp__code-mode__run                   1   denied  ← the bug
Read                                  1
Write                                 1
```

5 hook denials in `[tool_result]` payloads. The agent then `ToolSearch`ed for
`mcp__plugin_code-mode_code-mode__run` five times, got "No matching deferred
tools found" each time, and concluded:

> "Both tool families are blocked by code-mode's hook, and the plugin-prefixed
> alternatives aren't available in this session. I'll fall back to the Wikipedia
> REST API via Bash…"

That Bash fallback hit 403/404 on the Wikipedia REST API (Python `urllib`, no
user-agent), so the agent fabricated most of the final answer from training
knowledge and wrote it to `/tmp/…climate-deals.json`. The judge caught it:
grounding = 1.8, fulfillment = 1.8.

## Tells us

- **The block hook denies its own orchestration tool.** When the agent hits a
  blocked `mcp__Wikipedia__*`, the hook message recommends routing through
  `mcp__plugin_code-mode_code-mode__run` — but `mcp__code-mode__run` (the
  non-prefixed form, which is what the agent actually has access to) is *also*
  on the hook's denylist. So the documented escape hatch fails too.
- **The plugin-prefixed tool name in the denial message isn't real** — at least
  not under the form shown to the agent. `ToolSearch select:mcp__plugin_code-mode_code-mode__run`
  returns "No matching deferred tools found". Either the hook message is lying
  about the callable name, or the plugin isn't exposing the run tool under the
  expected `mcp__plugin_<plugin>_<server>__run` shape in this launch config.
- **Block variant is currently untestable on this bench.** Every task that
  needs the blocked MCP stack will regress to Bash/REST fallback and score like
  this one. Can't compare block vs baseline quality until the hook is fixed.
- **Negative result is still useful**: it catches a real bug in the plugin's
  self-denial logic that wouldn't have shown up in our in-repo harness, because
  our in-repo tasks all whitelist `mcp__code-mode__run`.

## Next steps

1. **Fix the block hook** (code-mode plugin): either
   (a) exempt `mcp__code-mode__run` (and the other `mcp__code-mode__*` meta
       tools: `search`, `save`, `listSdks`, `queryTypes`) from the denylist,
   or
   (b) make the denial message recommend the form that's actually callable in
       the current session. Pick (a) — the unprefixed `mcp__code-mode__run` IS
       a legitimate discoverable tool; it shouldn't be self-denied.
2. **Confirm the recommended plugin-prefixed form actually works** — either it
   exists and should be in `ToolSearch` results, or the denial message string
   is wrong. Fix whichever side is lying.
3. **Re-run `claude-code-codemode-block` on `wikipedia_000`** after (1). Only
   then proceed to `_smoke5.json` per the baseline log's step-3.
4. **Propagate the pending fork fixes** (unchanged from baseline log's step-2):
   `CLAUDE_CODE_TIMEOUT_S=900` default in `claude_code_executor.py`,
   `success` flag in `execution_results`, `provider.py` `max_completion_tokens`
   patch — all still only in the local fork.

## Cost ledger (this session)

- Block run: $0.45 agent + ~$0.02 judge = **~$0.47**.
- Session total (this run alone): ~$0.47. Running tally across today's bench
  work (carrying forward from the baseline log's $3.10): **~$3.57**.
