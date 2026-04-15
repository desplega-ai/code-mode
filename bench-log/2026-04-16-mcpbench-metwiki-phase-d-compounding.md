---
date: 2026-04-16
external_bench: mcp-bench (Accenture)
models: [claude-sonnet-4-6 via claude-code-codemode-block]
variants: [claude-code-codemode-block]
tasks: [metropolitan_museum_wikipedia_000]
total_runs: 2 (v1 hit a portability bug; v2 ran clean after fix)
total_cost_usd: ~$2.40 (v1 ~$1.30, v2 ~$1.10)
status: portability-bug-found-and-fixed + mixed-signal-on-compounding-hypothesis
related:
  - bench-log/2026-04-15-mcpbench-metwiki-intent-autosave-win.md (Phase C iter1 = fresh seed)
---

# 2026-04-16 — Phase D compounding test: portability bug + reuse-as-callables negative

Follow-up to yesterday's Phase C: re-run the same Met+Wiki task in a
fresh workdir seeded with iter1's 14 auto-saved scripts, to test
whether compounding-via-shared-state produces faster/cheaper second
runs. Adapter change: `CLAUDE_CODE_SHARED_SCRIPTS_AUTO=<abs path>`
env var that copies `<seed>/*.ts` into the new workdir's
`.code-mode/scripts/auto/` before reindex.

**Two signals, both worth keeping:**

1. **Caught a real portability bug.** v1 ran 3920s (65 min) before
   finishing — vs 435s for iter1. Root cause: auto-save was persisting
   the *post-rewrite* source with absolute paths baked into import
   specifiers. Iter2 tried to run scripts whose imports pointed at
   iter1's specific `/var/folders/.../iter1-workdir/sdks/...` paths,
   the agent burned 60+ minutes in a debugging loop authoring 8
   "test-import-path" scripts. Fix in `d501a4c`: save the PORTABLE
   source (BOM/fence stripped, `@/...` specifiers intact) and apply
   `rewriteWorkspaceAliases` only to the executable tmpfile. Regression
   test in `test/mcp/server.test.ts`. Full suite 252/252.

2. **"Reuse as callables" hypothesis didn't hold on v2.** After the
   fix, iter2 ran cleanly in 565s — but made **zero `mode: named`**
   calls. Agent searched 3 times, found no matches it wanted to invoke,
   and authored 13 fresh inline scripts. The saved scripts from iter1
   helped, but as *reference* (agent reads them), not as *callables*
   (agent invokes them by name).

## What ran

```bash
# /tmp/metwiki-phase-d.sh — same task, iter1 block seed mounted via env
SEED=/var/folders/nk/.../mcpbench-claude-0f0u0iom/.code-mode/scripts/auto
CLAUDE_CODE_SHARED_SCRIPTS_AUTO=$SEED python run_benchmark.py \
  --models claude-code-codemode-block \
  --tasks-file tasks/_smoke_metwiki.json \
  --distraction-count 0
```

- Task: `metropolitan_museum_wikipedia_000` (same as Phase C).
- Model: `claude-sonnet-4-6`.
- Seed: 14 auto-saved scripts from Phase C iter1's preserved workdir.
- v1 workdir (bugged): `.../mcpbench-claude-ksnq3uic` — 3920s
- v2 workdir (fixed): `.../mcpbench-claude-quzwf9xw` — 565s
- Score files: `benchmark_results_20260415_191859.json` (v1, contaminated),
  `benchmark_results_20260415_193259.json` (v2, valid).

## Numbers — iter1 (fresh, Phase C) vs iter2 v2 (seeded, fixed)

| Dimension (judge)            | iter1  | **iter2** | Δ       |
|------------------------------|--------|-----------|---------|
| task_completion              | 7.2    | 7.1       | −0.1    |
| **tool_selection**           | 6.7    | **7.3**   | **+0.6**|
| planning_effectiveness       | 6.2    | 6.4       | +0.2    |
| task_fulfillment             | 7.0    | 6.8       | −0.2    |
| grounding                    | 7.4    | 7.4       | tied    |
| tool_appropriateness         | 7.2    | 7.4       | +0.2    |
| **parameter_accuracy**       | 6.2    | **7.2**   | **+1.0**|
| dependency_awareness         | 7.4    | 7.0       | −0.4    |
| **parallelism_efficiency**   | 5.0    | **5.8**   | **+0.8**|
| tool_call_success_rate       | 95.0%  | 96.5%     | +1.5pp  |

| Telemetry                    | iter1  | **iter2** | Δ       |
|------------------------------|--------|-----------|---------|
| agent wall time              | 435 s  | 565 s     | **+30%**|
| MCP-Bench rounds             | 38     | 43        | +13%    |
| tool_use calls               | 20     | 29        | +45%    |
| named runs (mode=named)      | —      | **0**     | —       |
| search calls                 | 3      | 3         | tied    |

v2 is *more accurate* (+1.0 parameter, +0.8 parallelism, +0.6 tool-selection)
and *slower + more tool calls*. Quality up, efficiency down. Quality win
is real; it's the "examples as reference" effect — the agent reads seeded
scripts to understand the API shape, writes better code as a result.

## Why zero named calls — saved scripts are task-instance-specific

Head of a representative seed file, `fetch-met-metadata-for-all-21-monet-object-ids.ts`:

```ts
const IDS = [435848, 437261, 438816, ..., 437980];  // 21 hardcoded IDs
```

The IDs come from iter1's specific `search-museum-objects` result at
the moment it was run. Iter2 performs its own search and could easily
get a different set (the Met's API is stable but not deterministic
across query variants). A named call to this script would execute with
the wrong inputs.

The agent (correctly) figured this out: it read the script, saw the
hardcoded data, and chose to write a fresh one parameterized by its
own search results. Rational behavior — the saved script is a
*specific computation*, not a *reusable function*.

This is a fundamental limitation of naive auto-save on tasks with
task-instance data (IDs, dates, specific filter values). It does NOT
affect tasks where inputs are stable across runs (e.g., "fetch
weather for Paris" always takes the same args).

## Tells us

- **The portability fix was worth the day.** Even without the compounding
  payoff, the absolute-path bug would have corrupted any future seed-
  copy or snapshot-restore workflow. Regression tested and locked in.
- **"Auto-saved scripts improve code quality"** (+1.0 parameter_accuracy,
  +0.8 parallelism) is an unexpected finding worth isolating in a
  follow-up. The mechanism is "agent learns the API from examples",
  not "agent reuses work" — so it could work on ANY task with a non-
  trivial SDK, not just compounding-friendly ones.
- **"Auto-saved scripts get called by name"** requires either (a) picking
  tasks with stable inputs, (b) teaching the agent to author
  parameterized helpers (system prompt nudge), or (c) post-processing
  auto-saves to strip hardcoded data — none of which we did today.
- **N=1 is still too thin.** Phase C + Phase D together give us one
  sample per condition on one task. The efficiency delta on iter1 was
  large (−40% wall time, −66% cost) so noise is unlikely to flip the
  sign there, but the judge scores (tied within ±0.4) and iter2's
  wall-time regression (+30%) are small enough that a single run
  doesn't close the case.

## Three Phase D commits landed

1. `d501a4c` — code-mode: auto-save portable source (fix seed-copy brittleness)

And yesterday's Phase B foundation (referenced):
- `d33bd88` — primitives (slug + auto-save + intent-log)
- `c6ce176` — wire intent into MCP handlers + auto-save on run
- `b9cfedc` — pretooluse passive reuse hint + sessionstart routing

Bench-adapter change (deployed to the mcp-bench fork, will need a
re-sync on any pull):
- `claude_code_executor.py`: added optional
  `CLAUDE_CODE_SHARED_SCRIPTS_AUTO=<abs path>` that copies `.ts` files
  from the seed dir into the workdir's `.code-mode/scripts/auto/`
  between `init` and `reindex`. Logs copy count. No-op when unset.

## Cost ledger (this session)

- Phase D v1 (bugged, 3920s runaway): ~$1.30
- Phase D v2 (fixed, 565s): ~$1.10
- Judge evaluation: ~$0.20
- **Session total: ~$2.60**
- Phase C (yesterday): $3.94
- **Two-day total: ~$6.54**
