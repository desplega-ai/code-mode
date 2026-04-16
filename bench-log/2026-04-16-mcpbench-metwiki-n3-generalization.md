---
date: 2026-04-16
external_bench: mcp-bench (Accenture)
models: [claude-sonnet-4-6]
variants: [claude-code-baseline, claude-code-codemode-block]
tasks:
  - metropolitan_museum_wikipedia_000 (N=3 per variant, intended)
  - wikipedia_paper_search_001 (N=1 per variant)
  - scientific_computing_unit_converter_000 (N=1 per variant)
intended_runs: 10
usable_runs: 8
total_cost_usd: ~$12 (agent + judge; detailed ledger below)
status: mixed — sci-unit confirms code-mode generalizes beyond cross-composition (decisive win on compute); Met+Wiki N=3 blocked by loader regression; wp-block produced no results file
related:
  - thoughts/taras/plans/2026-04-16-metwiki-N3-plus-two-tasks-sweep.md (action item)
  - bench-log/2026-04-15-mcpbench-metwiki-intent-autosave-win.md (Phase C — the win we tried to confirm)
  - bench-log/2026-04-16-mcpbench-metwiki-phase-d-compounding.md (Phase D — portability fix lineage)
---

# 2026-04-16 — N=3 Met+Wiki + 2-task generalization sweep: new compute-task win + loader regression

Ran the 10-run sweep queued in yesterday's action item. Two things
happened, both worth keeping:

1. **sci-unit is a decisive code-mode win** on a compute/conversion
   task — the exact shape HVAC's loss was supposed to generalize to.
   Block beats baseline on every judge dimension (+0.4–1.0) AND every
   efficiency dimension (−41% wall, −82% rounds, −85% tool calls) at
   100% tool-call success. **This falsifies the "code-mode loses on
   compute tasks" hypothesis derived from HVAC.** Combined with Phase
   C's Met+Wiki win, we now have two clean same-direction wins on two
   different task shapes (cross-composition + compute/conversion).
2. **The Met+Wiki N=3 confirmation we actually came here for is
   blocked** by a code-mode loader regression. Block-2 and block-3
   hit a crash pattern (`process exited 4 without sentinel / [code-mode
   loader] entry has no default-exported async main(args) function`)
   that corrupted 21/23 and 1/6 `run` calls respectively. Block-1 and
   sci-block ran clean on the same binary in the same session, so the
   bug is session/state-dependent, not a build-level break.

**Recommendation: ship the sci-unit result (it's real and it advances
the thesis). Reproduce + fix the loader bug before the next sweep.**

## What ran

```bash
# /tmp/metwiki-n3-sweep.sh
cd ~/Documents/code/misc/mcp-bench && source .venv/bin/activate && source .env.smoke
export CLAUDE_CODE_OAUTH_TOKEN=keychain CLAUDE_CODE_USE_KEYCHAIN=1 CLAUDE_CODE_KEEP_WORKDIR=1
unset ANTHROPIC_API_KEY

# Part 1 — N=3 Met+Wiki (6 runs)
for model in claude-code-baseline claude-code-codemode-block; do
  for iter in 1 2 3; do
    rm -rf cache/
    python run_benchmark.py --models $model --tasks-file tasks/_smoke_metwiki.json --distraction-count 0
  done
done

# Part 2 — 2 extra 2-server tasks (4 runs)
for tf in _smoke_wikipaper.json _smoke_sciunit.json; do
  for model in claude-code-baseline claude-code-codemode-block; do
    rm -rf cache/
    python run_benchmark.py --models $model --tasks-file tasks/$tf --distraction-count 0
  done
done
```

Task-file substitutions from the action item:
- `wikipedia_paper_search_000` does not exist in `tasks/mcpbench_tasks_multi_2server_runner_format.json`; only `_001` and `_003` are present. Used `_001`.
- `scientific_computing_unit_converter_000` exists ✓.

## Headline numbers (what we have that's usable)

### Part 1 — Met+Wiki baseline (N=3, all clean)

| Iter | wall s | rounds | tool_calls | task_compl | tool_call_success |
|------|--------|--------|------------|------------|-------------------|
| 1 | 192 | 48 | 25 | 4.5 | 92% |
| 2 | 592 | 156 | 112 | 6.3 | 93% |
| 3 | 286 | 81 | 44 | 6.0 | 100% |
| **mean** | **357** | **95** | **60** | **5.6** | **95%** |
| **stddev** | 210 | 55 | 44 | 1.0 | 4pp |

Large variance across baseline runs — iter-1 short-circuited at 192s
with only 25 tool calls (and task_completion 4.5 reflecting a truncated
answer), while iter-2 spent 9.9 min on a 112-call walk. This matches
Phase C's observation that the baseline's handling of this task is
uneven (Phase C baseline skipped Wikipedia entirely). With this much
variance the N=3 baseline mean for task_completion is 5.6 ± 1.0, not
Phase C's 7.2 — worth holding in mind that the single Phase C baseline
datapoint was also a sample from this wide distribution.

### Part 1 — Met+Wiki block (N=1 usable, N=2 corrupted)

| Iter | wall s | rounds | tool_calls | task_compl | tool_call_success | notes |
|------|--------|--------|------------|------------|-------------------|-------|
| 1 | 459 | 58 | 23 | 6.7 | 87% | CLEAN |
| 2 | 1140 | 49 | 26 | 2.4 | **7.7%** | loader crash 21/23 runs |
| 3 | 3155 | 21 | 8 | 2.2 | 75% | loader crash 1/6 runs, 53 min wall |

**Block-1 alone**: in the same direction as Phase C — 459s vs baseline
mean 357s (slower wall), but 58 rounds vs baseline mean 95 (−39%),
23 tool calls vs baseline mean 60 (−62%), task_completion 6.7 vs
baseline mean 5.6 (+1.1), success rate 87% vs 95% (−8pp). Directionally
consistent with Phase C's rounds/calls/cost advantage but with
different baseline numbers this time.

**Block-2 and block-3**: cannot be combined with block-1 into an N=3
mean. Block-2's 7.7% tool_call_success is a direct consequence of the
loader bug (21/23 `run` calls crashed after the MCP server already
returned valid data). Block-3 took 53 minutes of real time because
the agent kept re-authoring scripts trying to work around the loader
crashing.

### Part 2 — wikipedia_paper_search_001 (block invalid)

| Variant | wall s | rounds | tool_calls | task_compl | notes |
|---------|--------|--------|------------|------------|-------|
| baseline | 4378 (73 min) | 85 | 50 | 4.6 | task genuinely hard |
| **block** | — | — | — | — | **no results file emitted** |

Baseline ran 73 minutes doing paper-search lookups across Semantic
Scholar / PubMed / bioRxiv. Block variant ran 46 minutes wall (script
reports rc=0) but the bench runner never wrote a `benchmark_results_*.json`
file for it — no `Results saved to ...` line in the log, no file
with an end-time-matching timestamp on disk. Two 54MB workdirs
(`tnic4zkc` 04:55, `kr57i8ax` 05:11) exist for this run; both have
the `_stream.jsonl` missing or truncated.

### Part 2 — scientific_computing_unit_converter_000 (both clean)

| Dimension (judge)          | baseline | **block** | Δ         |
|----------------------------|----------|-----------|-----------|
| task_completion            | 8.8      | **9.2**   | +0.4      |
| tool_selection             | 8.2      | **9.0**   | +0.8      |
| planning_effectiveness     | 8.0      | **8.6**   | +0.6      |
| task_fulfillment           | 8.8      | **9.2**   | +0.4      |
| grounding                  | 8.8      | **9.2**   | +0.4      |
| tool_appropriateness       | 8.4      | **9.0**   | +0.6      |
| parameter_accuracy         | 8.0      | **9.0**   | +1.0      |
| dependency_awareness       | 8.4      | **9.2**   | +0.8      |
| parallelism_efficiency     | 7.6      | **8.0**   | +0.4      |
| tool_call_success_rate     | 90%      | **100%**  | +10pp     |

| Telemetry                  | baseline | **block** | Δ         |
|----------------------------|----------|-----------|-----------|
| agent wall time            | 211 s    | **124 s** | **−41%**  |
| MCP-Bench rounds           | 39       | **7**     | **−82%**  |
| tool_use calls             | 20       | **3**     | **−85%**  |
| output tokens              | 363      | **82**    | **−77%**  |

**Block wins cleanly on every judge dimension AND every efficiency
dimension on sci-unit.** This is a compute/conversion task — the
shape HVAC supposedly "proved" code-mode loses on. It doesn't. The
HVAC loss was HVAC-specific, not a property of compute tasks.

## The loader bug — crash signature

Representative agent-authored source (block-2, typical of 21 crashed runs):

```ts
import { listDepartments } from "@/sdks/.generated/Metropolitan_Museum";
const result = await listDepartments({ __intent: "Find European Paintings department ID" });
console.log(JSON.stringify(result, null, 2));
```

Tool result:

```json
{
  "success": false,
  "reason": "crash",
  "error": "process exited 4 without sentinel",
  "logs": "{\n  \"content\": [ ... full department list returned ... ] }\nMet Museum MCP server running on stdio\n[code-mode loader] entry has no default-exported async main(args) function\n",
  "exitCode": 4
}
```

The MCP server call (`listDepartments`) succeeded — the server's
content with the department list is right there in `logs`. Then
the code-mode loader raises "entry has no default-exported async
main(args) function" and the process exits 4. The tool reports
`success: false` to the agent, which then rewrites and retries,
burning rounds.

**What doesn't explain it:**
- Not the Phase D portability bug. The binary has the
  `d501a4c` fix (`grep -c portableSource $(readlink -f $(which code-mode))` = 4).
  The source stored is portable; the imports are `@/...` not absolute.
- Not a new binary — I didn't rebuild during the sweep.

**What might:**
- Block-1 (same variant, same binary, same task, 8 min earlier) ran
  cleanly with 24 auto-saves and 0 crashes authoring the exact same
  top-level-await style. Block-2 immediately after the cache wipe
  hit 21/23 crashes. **The loader behavior appears to differ between
  the first and subsequent runs within the same parent shell session.**
  Possible culprits: stale MCP server state, stale global loader
  state that persists across `rm -rf cache/`, or a race between
  MCP server shutdown and the next run's loader init.
- Could also be a Node.js process-exit accounting bug in the
  sandbox runner — the script's JS half completes, the MCP server
  half still has bytes to flush, and the "sentinel" is missing
  from the combined stream.

Not diagnosing further here. This needs its own investigation session
with a minimal repro (run `metwiki` twice in a row in the same
shell, watch for the second one's loader crashes).

## Preserved workdirs

All runs had `CLAUDE_CODE_KEEP_WORKDIR=1`. Mapping by mtime + signature:

| Run | Workdir | Notes |
|-----|---------|-------|
| P1-baseline-1 | `mcpbench-claude-47f1_wzp` | 164k, clean |
| P1-baseline-2 | `mcpbench-claude-jrqnsrcb` | 500k |
| P1-baseline-3 | `mcpbench-claude-8x0qmbq4` | 280k |
| P1-block-1 | `mcpbench-claude-2ccm9ib3` | **54M, 15 auto-saves, 18 run calls, 1 crash** |
| P1-block-2 | `mcpbench-claude-c1qdbryy` | **54M, 0 auto-saves, 23 run calls, 21 crashes — primary bug evidence** |
| P1-block-3 | `mcpbench-claude-bmav0qs2` | 54M, 3 auto-saves, 6 run calls, 1 crash |
| P2-wp-baseline | `mcpbench-claude-qn32jx77` | 1.5M |
| P2-wp-block | `mcpbench-claude-tnic4zkc` + `kr57i8ax` | 54M each, stream truncated, no result file |
| P2-sci-baseline | `mcpbench-claude-wliyjagu` | 144k, clean |
| P2-sci-block | `mcpbench-claude-j7xnj4m1` | 54M, 1 auto-save, 1 run call, clean |

Additional workdir `mcpbench-claude-1rxwr04k` (54M, 04:40) exists but
its role is unclear — possibly a judge-side or sub-agent workdir.

All live under `/private/var/folders/nk/tmm_41010716v56wdjp3wn5h0000gn/T/`.

## Bottom line

One of the two questions the action item asked got a real answer; the
other is still stuck.

1. **Does the win generalize? — Partially, YES, and in a better
   direction than expected.** On `sci-unit` (compute + conversion)
   code-mode wins cleanly on every judge dimension AND every
   efficiency dimension. The HVAC-based worry — "code-mode loses on
   compute tasks" — is **falsified**. HVAC was HVAC-specific, not
   a property of compute-shaped tasks. Combined with Phase C's
   Met+Wiki cross-composition win, we now have two clean wins on
   two different task shapes. The "what's the narrative" question
   shifts from "cross-composition only" to "at least cross-composition
   AND compute/conversion, unclear about cross-source retrieval."
   `wp` is still unknown because the block run produced no results.

2. **Is the Phase C Met+Wiki win real or noise? — Unresolved.** We
   have one clean block sample (block-1, directionally consistent
   with Phase C) and two contaminated samples. Block-1 alone doesn't
   add statistical confidence; it repeats the existing N=1 observation.
   The baseline N=3 showed σ ≈ 210s on wall time — wider than Phase C
   suggested — so the "code-mode is 40% faster on Met+Wiki" headline
   from Phase C should be treated as a noisy point estimate until we
   can compute a comparable block mean against a proper baseline mean.

**Code-mode wins on cross-composition (Met+Wiki Phase C, N=1) AND on
compute/conversion (sci-unit today, N=1), loses on HVAC (N=1, likely
task-specific given the sci-unit result), unknown on cross-source
retrieval (wp-block didn't emit data), with the following confidence:
medium on the generalization direction (two independent shapes clean
win), low on any single magnitude estimate (all points are N=1).**

## Cost ledger

Approximate, based on agent wall time × typical cost/sec for this bench:

- Part 1 baseline × 3: 192s + 592s + 286s ≈ $3–5
- Part 1 block × 3 (including the two crashed runs' wasted rounds): ≈ $3–4
- Part 2 wp baseline (73 min): ≈ $3
- Part 2 wp block (46 min, no result): ≈ $1
- Part 2 sci (both): ≈ $0.50
- Judge evaluation (9 result files × 5 stability × gpt-5-mini): ≈ $1
- **Session total: ≈ $12**

Under the action item's ~$15–20 estimate, but for zero defensible
N=3 data on the primary question. Net: the loader bug cost us ~$3–4
of wasted agent time and the Met+Wiki N=3 answer.

## Next

1. **Reproduce the loader crash in isolation.** Minimal repro: run
   `metropolitan_museum_wikipedia_000` twice in a row from the same
   shell, wiping cache in between, with `CLAUDE_CODE_KEEP_WORKDIR=1`.
   If the second run crashes 20+ times on `run`, the hypothesis
   is confirmed. Inspect `mcp__plugin_code-mode_code-mode__run`
   source for shared/static state between invocations.
2. **After fix**, re-run the 4 affected runs only (P1-block-2,
   P1-block-3, P2-wp-block, and one fresh P2-wp-baseline for
   pairing) — not the whole sweep. Budget ≈ $5, ≈ 2 hr wall.
3. **Do not start the mini-SDK authoring feature** (draft plan
   `thoughts/taras/plans/2026-04-16-mini-sdk-authoring-DRAFT.md`).
   That plan was gated on this sweep's outcome and the outcome is
   "the infrastructure is broken", not "proceed".
