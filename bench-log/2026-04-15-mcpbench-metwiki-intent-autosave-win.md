---
date: 2026-04-15
external_bench: mcp-bench (Accenture)
models: [claude-sonnet-4-6 via claude-code-baseline, claude-code-codemode-block]
variants: [claude-code-baseline, claude-code-codemode-block]
tasks: [metropolitan_museum_wikipedia_000]
total_runs: 2 (N=1 per variant, single fresh Phase C validation)
total_cost_usd: ~$3.94 (agent $3.64 + judge ~$0.30)
status: first-win-for-code-mode-on-cross-composition + intent/auto-save feature validated
related:
  - bench-log/2026-04-15-mcpbench-multi-mcp-first-clean.md (HVAC, where block LOST)
  - bench-log/2026-04-14-mcpbench-block-fixed.md (Wikipedia N=1 baseline)
---

# 2026-04-15 — Met+Wiki cross-composition: code-mode wins decisively

First bench run on a genuinely cross-composition multi-MCP task
(`metropolitan_museum_wikipedia_000` — loop over N Monet paintings,
join Met metadata with Wikipedia summaries, cross-validate, produce
structured report). Also the first run with the **intent + auto-save**
feature live on the MCP `run`/`save`/`search`/`query_types` tools.

**Block beats baseline on every efficiency dimension at tied quality.**
Block is 40% faster, uses 60% fewer rounds, 70% fewer tool calls,
66% cheaper, and has +7.3pp higher tool-call success rate — while
the judge scores all dimensions within ±0.4 of baseline. This is the
opposite of yesterday's HVAC result, where the task was repetitive
compute with no composition surface and block lost on every metric.

## What ran

```bash
# /tmp/metwiki-phase-c.sh — separate invocations per model with cache wipe
# between runs, default auto-generated output filenames so per-model
# scores don't overwrite.
cd ~/Documents/code/misc/mcp-bench && source .venv/bin/activate && source .env.smoke
export CLAUDE_CODE_OAUTH_TOKEN=keychain CLAUDE_CODE_USE_KEYCHAIN=1
export CLAUDE_CODE_KEEP_WORKDIR=1
unset ANTHROPIC_API_KEY

for model in claude-code-baseline claude-code-codemode-block; do
  rm -rf cache/
  python run_benchmark.py \
    --models $model \
    --tasks-file tasks/_smoke_metwiki.json \
    --distraction-count 0
done
```

- Task: `metropolitan_museum_wikipedia_000`. Iterative loop: list
  Met departments → search for Monet paintings in European Paintings
  → fetch metadata for each → search Wikipedia by title with fallback
  → extract 3 composition-focused summaries per painting → cross-validate
  objectDate/medium across sources → produce structured report.
- Model: `claude-sonnet-4-6` (both variants).
- Judge: `gpt-5-mini` via OpenAI.
- Raw score files:
  - Baseline: `benchmark_results_20260415_174840.json`
  - Block: `benchmark_results_20260415_175654.json`
- Preserved workdirs (`CLAUDE_CODE_KEEP_WORKDIR=1`):
  - Baseline: `.../mcpbench-claude-ilyxu636`
  - Block: `.../mcpbench-claude-0f0u0iom` ← has 14 auto-saved scripts,
    used as seed for Phase D compounding test.

## Headline numbers

| Dimension (judge, 0–10)      | baseline | **block**  | Δ       |
|------------------------------|----------|------------|---------|
| task_completion              | 7.2      | **7.2**    | tied    |
| tool_selection               | 6.8      | 6.7        | −0.1    |
| planning_effectiveness       | 6.1      | **6.2**    | +0.1    |
| task_fulfillment             | 7.0      | **7.0**    | tied    |
| grounding                    | 7.4      | **7.4**    | tied    |
| tool_appropriateness         | 7.4      | 7.2        | −0.2    |
| parameter_accuracy           | 6.2      | **6.2**    | tied    |
| dependency_awareness         | 7.0      | **7.4**    | **+0.4**|
| parallelism_and_efficiency   | 5.2      | 5.0        | −0.2    |
| task_success_rate            | 1.0      | 1.0        | tied    |
| **tool_call_success_rate**   | 87.7%    | **95.0%**  | **+7.3pp** |

| Telemetry                    | baseline | **block** | Δ       |
|------------------------------|----------|-----------|---------|
| **agent wall time**          | 721.4 s  | **435.5 s** | **−40%** |
| **MCP-Bench rounds**         | 97       | **38**    | **−60%**|
| **tool_use calls**           | 65       | **20**    | **−69%**|
| **Claude Code cost**         | $2.72    | **$0.92** | **−66%**|
| cache_read tokens            | 140 k    | 324 k     | +132%   |
| cache_creation tokens        | 10.5 k   | 44 k      | +315%   |
| output tokens (SDK)          | 6,225    | 9,221     | +48%    |

Block burns more cache + output tokens per round (writing TS code is
more verbose than invoking a named MCP tool), but the round count
drops so much that total cost still falls 66%. Cost per
task-completion-point: baseline $0.378, block $0.128 — **block is ~3×
more cost-efficient at tied quality** on this task.

## Tool-call shape comparison

**Block (20 calls total, 95% success):**
```
 15  mcp__code-mode__run
  3  mcp__code-mode__search
  1  ToolSearch
  1  Agent
```

**Baseline (65 calls, 87.7% success):**
```
 52  mcp__Metropolitan_Museum__get-museum-object   ← painful N=52 fetch loop
  9  mcp__Metropolitan_Museum__search-museum-objects
  1  mcp__Metropolitan_Museum__list-departments
  1  ToolSearch
  1  Agent
  1  Read
```

Baseline's dominant cost is 52 sequential `get-museum-object` calls.
Block folded all 21 Met object fetches into a single inline `run` script
that also did the Wikipedia lookups and cross-validation in one pass —
the "batch operations into scripts" thesis of code-mode, playing out.

Notably, **baseline made zero Wikipedia calls**. It apparently decided
to stop at Met metadata and skip the Wikipedia join entirely. Judge
still gave it 7.2/7.4 grounding because what it DID deliver was
grounded — but it's a task-coverage gap the block variant didn't have.

## Intent + auto-save feature validation

All four new signals present in the block workdir
(`mcpbench-claude-0f0u0iom`):

- **14 auto-saved files** under `.code-mode/scripts/auto/` with
  meaningful intent-derived slugs:
  - `list-met-museum-departments-to-find-european-paintings-id.ts`
  - `search-met-museum-for-monet-paintings-in-european-paintings.ts`
  - `fetch-met-metadata-for-all-21-monet-object-ids.ts`
  - `fetch-wikipedia-articles-for-5-monet-paintings-and-extract.ts`
  - `compile-final-structured-wikipedia-data-for-all-5-monet.ts`
  - (+9 others with similar shape)

- **7 `"autoSaved": {"reason":"saved",...}` tool_result entries** in
  the stream (15 run calls total; the 8 unaccounted for are likely
  skipped-trivial or had errors).

- **18 intent-log entries** at `.code-mode/intent-log.jsonl` spanning
  all four intent-accepting tools. First entry is telling:
  ```
  [0] search: "check for existing Met Museum Monet scripts"
  [1] run:    "list Met Museum departments to find European Paintings ID"
  [2] run:    "search Met Museum for Monet paintings in European Paintings with images"
  ```
  The agent reflexively searched for prior work before writing its
  first inline script — exactly the reuse-first pattern the feature
  is meant to encourage. No nudge needed from the pretooluse hint
  (fresh workdir had nothing to match on, so the hint was silent).

- **Baseline zero interference:** baseline workdir has 0 auto-saves,
  0 intent log, 0 code-mode calls. Feature is block-mode-scoped
  correctly.

## Tells us

- **Code-mode's thesis validates on cross-composition tasks.** When
  the task involves looping over N unknown items with 2+ API calls
  per item + a data join, scripted composition beats per-call tool
  routing on cost, rounds, tool-call success, and wall time — at
  tied quality. HVAC was the wrong shape; Met+Wiki is the right one.
- **Intent + auto-save works end-to-end in realistic conditions.**
  Not just unit tests: live agent in an external bench environment
  produced meaningful slugs and a searchable corpus on the first
  run with no training. This unblocks Phase D (compounding).
- **N=1 caveat.** These are single-shot numbers. The efficiency
  gap is large enough that noise can't swallow it, but the judge
  scores (tied within ±0.4) are close enough that a second run
  could flip sign on individual dimensions. Phase D (paired
  iter-1/iter-2 on shared state) gives us the N=2 on block, and
  any meaningful comparison will need more samples.
- **Baseline skipped Wikipedia.** That's a task-coverage gap, not
  a shape problem with the bench — the task description clearly
  asks for Wikipedia joins. Worth noting but not correcting here
  (can't retroactively nudge the agent).

## Three Phase B commits landed this session

1. `d33bd88` — code-mode: slug + auto-save + intent-log primitives
2. `c6ce176` — code-mode: wire intent into MCP handlers + auto-save on run
3. `b9cfedc` — code-mode: pretooluse passive reuse hint + sessionstart routing

All green on 269-test suite. CLI rebuilt; `npm link` points the global
binary at the local source tree so the bench picks up changes
automatically on rebuild.

## Next

1. **Phase D compounding test.** Copy block workdir's
   `.code-mode/scripts/auto/` + `code-mode.db` into a fresh workdir as
   seed state, run the same task again, measure iter-2 reuse rate.
   Expected: `__search` fires early, `mode: named` calls replace
   several `mode: inline` calls, round count drops further.
2. **Second N on Phase C.** If Phase D numbers still look clean,
   rerun Phase C once more to get N=2 on both variants and lock
   down the efficiency delta.
3. **Bench-adapter shared-state plumbing.** Add
   `CLAUDE_CODE_SHARED_CODE_MODE_STATE=<path>` to
   `claude_code_executor.py` so Phase D can be reproduced.

## Cost ledger (this session)

- Phase C runs: $2.72 (baseline) + $0.92 (block) = **$3.64** agent.
- Judge evaluation: ~$0.30 (5 stability samples × gpt-5-mini × 2 runs).
- **Session total: ~$3.94.**
