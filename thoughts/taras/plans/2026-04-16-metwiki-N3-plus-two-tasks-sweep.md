---
date: 2026-04-16
status: queued
owner: taras+claude
parent: bench-log/2026-04-16-mcpbench-metwiki-phase-d-compounding.md
est_cost_usd: ~$20
est_wall_time: ~90 min
---

# Action item — N=3 Met+Wiki + 2 new 2-server tasks sweep

Close the two open questions from this week's bench work before any more
feature development or compounding experiments:

1. **Is the Phase C Met+Wiki win real or noise?** Single N=1 sample.
   Efficiency delta is large (−40% wall / −60% rounds / −66% cost) so
   noise unlikely to flip sign, but judge scores tied within ±0.4, and
   that's thin enough that a second run could reorder individual
   dimensions.

2. **Does the win generalize beyond Met+Wiki, or was the task shape
   cherry-picked?** HVAC (04-15) was a loss on every dimension. Met+Wiki
   was a win on every dimension. With only two data points and one
   positive, we cannot claim anything general about code-mode value.

## What to run

**Part 1 — N=3 Met+Wiki, both variants (primary cost).** 6 runs total.
Same task file (`tasks/_smoke_metwiki.json`), same env setup, separate
invocations per model + cache wipe per invocation (the Phase C bench
script template `/tmp/metwiki-phase-c.sh` with N=3 loop).

- `claude-code-baseline` × 3
- `claude-code-codemode-block` × 3
- Expected cost: ~$2.72 × 3 + $0.92 × 3 ≈ **$11**
- Expected wall time: ~(12 min + 7 min) × 3 ≈ **60 min**
- Preserve workdirs (`CLAUDE_CODE_KEEP_WORKDIR=1`) — needed if any run
  diverges from the N=1 shape and we need to diagnose.

**Part 2 — two additional 2-server tasks, N=1 each, both variants.**
4 runs total. Pick from `tasks/mcpbench_tasks_multi_2server_runner_format.json`.
Suggested pairs, balancing shape diversity and server build state:

- `wikipedia_paper_search_000` — retrieval-heavy, cross-source synthesis.
  Similar shape to Met+Wiki (cross-composition on structured data).
  Validates that the win wasn't Met-API-specific.
- `scientific_computing_unit_converter_000` — compute + conversion.
  Similar shape to HVAC (repetitive numeric work). Validates that
  HVAC loss wasn't Unit_Converter-specific.

Before running: verify both servers have a `.venv/` (rerun
`presync-venvs.sh` if not) and that each connects cleanly in isolation
(`python run_benchmark.py --models claude-code-baseline --tasks-file
tasks/<single>.json --distraction-count 0`).

- Expected cost: ~$2 per task pair × 2 pairs = **$4–5**
- Expected wall time: depends on task — budget **30 min**

**Total**: ~$15–16 bench + judge, ~90 min wall time.

## Decision criteria

After the sweep, we can answer:

- **"Is Met+Wiki win real?"** — look at N=3 mean/stddev on block vs
  baseline. If block's efficiency advantage holds across all 3 samples
  and judge scores are within ±0.5 of baseline on N=3 mean, the win is
  defensible. If any single run flips the sign on a headline number
  (wall time, rounds, cost), we need N=5+.

- **"Does it generalize?"** — Wikipedia+Paper Search and Sci Computing
  +Unit Converter should tell us the shape pattern:
  - Both cross-composition (Wiki+Paper, maybe Sci+Unit) → code-mode
    wins: thesis generalizes, we have a narrative ("cross-source
    composition tasks").
  - Only Met+Wiki-like tasks win, compute tasks lose → thesis is
    narrow but clean ("cross-source composition, not repetitive
    compute").
  - Neither wins (Met+Wiki was noise) → pull back, more fundamental
    investigation needed.

## Not doing in this sweep

- Compounding experiments (see Phase D bench-log). Parking until we
  have a task with stable inputs or we've taught the agent to author
  parameterized helpers.
- "Auto-saved scripts as examples" quality effect. Separate, follow-
  on experiment — see the exec summary dated 2026-04-16 for design.
- Model fanout (Opus vs Sonnet) — keep sonnet-4-6 only to minimize
  variables.

## Preconditions to verify before starting

- [ ] `code-mode` binary: symlinked to `packages/core/dist/cli.js`,
      last built after commit `d501a4c` (Phase D portability fix).
      `grep -c "portableSource" $(readlink -f $(which code-mode))`
      should return ≥1.
- [ ] `bench/external/mcp-bench-adapter/claude_code_executor.py`
      deployed to `misc/mcp-bench/agent/claude_code_executor.py`.
- [ ] Both chosen servers for Part 2 connect cleanly via a smoke run.
- [ ] `.env.smoke` has a non-expired OAuth sentinel (`keychain` + the
      Keychain-auth flag). Capped bench/.env token is the trap from
      `memory/feedback_bench_oauth_strip.md`.

## Artifacts to produce

- `bench-log/2026-04-16-mcpbench-metwiki-n3-generalization.md`
  (or whenever the sweep completes, use the completion date).
- Preserved workdir paths for each of the 10 runs, listed by variant/iter.
- Numeric tables: N=3 means + stddev for Met+Wiki, N=1 numbers for the
  two new tasks.
- **Bottom line** paragraph: "Code-mode wins on \_\_\_-shaped tasks
  and loses on \_\_\_-shaped tasks, with the following confidence."
