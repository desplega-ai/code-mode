---
title: "Multi-MCP empirical findings — hint vs block"
author: claude (for taras)
date: 2026-04-14
status: research
related:
  - thoughts/taras/research/2026-04-14-code-mode-value-prop-reframing.md
  - thoughts/taras/research/2026-04-14-multi-mcp-bench-feasibility.md
  - bench/tasks/multi-mcp-upsert/
---

# Multi-MCP empirical findings

First durable positive signal for code-mode in the whole bench effort. Durable across three N=3 Sonnet sweeps on the `multi-mcp-upsert` task (dbhub + deepwiki + SQLite fixture).

## Headline

**Registering code-mode alongside other MCPs reduces cost ~19–30% on Sonnet, even when the model never calls `mcp__code-mode__*` directly.** The savings come from reduced speculative `ToolSearch` behaviour (2–3 per run → 1 per run) driven by the SKILL.md routing text.

## Three variants tested (N=3 each, 3 separate sweeps)

| Variant | Cost (median) | Turns (median) | Key tool pattern |
|---|---|---|---|
| `multi-mcp-baseline` | $0.063–$0.077 | 11–13 | dbhub=2, deepwiki=1, **ToolSearch=2–3** |
| `multi-mcp-codemode` (hint) | **$0.051–$0.054** (−19 to −30%) | **9–10** (−15 to −25%) | dbhub=2–3, deepwiki=1, **ToolSearch=1** |
| `multi-mcp-block` (block, with hints) | $0.086 (+36% vs baseline) | 16 | `__run×1–2`, Bash×2, denied-dbhub, variable |

All 27 runs across all three sweeps produced correct output (smoke_pass=true).

**Sonnet never autonomously called `mcp__code-mode__*` in any hint-mode run.** The value prop here is entirely from the plugin's system-prompt-level steering, not from tool wrapping.

## Block mode: forces wrapping, but net-negative on cost

`CODE_MODE_MCP_BLOCK=1` + whitelist excludes dbhub/deepwiki → PreToolUse hook denies them → model must pivot.

- **2/3 runs** (before hint improvements) discovered `mcp__code-mode__run` and routed through it.
- **1/3 runs** kept retrying the denied tool 4× and fell back to Bash, never finding `__run`.
- **+90% cost, ~2× turns** vs hint mode.

After improving the deny reason to include a concrete runnable `__run` snippet with the right import path + function name, and adding an SDK cheat sheet to SessionStart:

- **3/3 runs** discovered `__run` (up from 2/3).
- Median cost dropped from $0.099 → $0.086 (−13%).
- **But one run used the new flexibility to over-explore** (30 turns, WebSearch + `__run`×2 + Bash×2, $0.213). Tail risk grew.
- Block still loses to hint by ~70% on median cost.

**Conclusion: block is useful for safety/auditing use cases, not for performance.** Hint mode is Pareto-optimal on this task with Sonnet.

## Bug surfaced: `--plugin-dir` doesn't register PreToolUse hooks

Claude Code's `claude --plugin-dir <path>` activates a plugin's:

- MCP server (tools get `mcp__plugin_<name>_*` namespace) ✓
- SessionStart hook (verified via `additionalContext` injection) ✓
- **PreToolUse hooks NOT registered** ✗

Verified via `--include-hook-events`: zero hook events fire for `mcp__dbhub__*` calls under `--plugin-dir` alone.

**Workaround** (shipped in `bench/docker/entrypoint.sh` for the `multi-mcp-block` variant): register the hook directly in `~/.claude/settings.json`, pointing at the mounted plugin's `hooks/pretooluse.mjs`. This works.

Candidate upstream bug to file against `anthropics/claude-code` — every plugin author shipping PreToolUse hooks is affected.

## What the signal is actually doing

The codemode variant's `ToolSearch=1` vs baseline's `ToolSearch=2–3` is the giveaway:

- Baseline Sonnet fans out to `ToolSearch` speculatively at the start of planning ("let me see what's available").
- With code-mode's SessionStart context injected ("search first, prefer typed SDKs, don't write throwaway code"), Sonnet skips the speculative search and commits to a direct path.
- That single extra `ToolSearch` per baseline run accounts for ~2–3 turns of assistant/tool/response overhead — exactly the observed Δ.

**Generalisation risk**: this effect hinges on the SKILL.md text discouraging a specific speculative behaviour. Any task where ToolSearch isn't the dominant planning cost won't show this signal. Tasks dominated by the actual tool-execution work (e.g. long `WebFetch`) won't benefit — confirmed by `multi-api-join` data where network latency dominated.

## What to test next

1. **More MCPs registered** (stress the "tool description bloat" hypothesis). Cut 2 from the feasibility doc: add playwright-mcp (~25 tools) to see if the cost delta scales with tool surface.
2. **Tasks where the model naturally reaches for `__run`**. Currently 0/54 runs across all hint-mode sweeps actually called `mcp__code-mode__run`. Either the tasks don't need it or the affordance isn't strong enough. The controlled block test proves the pathway works when pushed; now build a task where it's unambiguously the right path.
3. **Bench B cross-session persistence at N=3**. N=1 showed −29% s2 cost. If this holds at N=3, it's a second independent positive signal.
4. **Different models**: the whole positive signal is Sonnet 4.6. Does it hold on Haiku 4.5 (cheaper, weaker planning)? On Opus 4.6 (better planning, maybe less susceptible to speculative ToolSearch)?

## Update — Opus 4.6 confirms the signal (N=3, 2026-04-14)

Reran the same 3-variant sweep on `claude-opus-4-6` (`results/opus-multimcp-n3/`).

| Variant | Cost (median) | Tokens (median) | Tool calls | Wall (median) |
|---|---|---|---|---|
| `multi-mcp-baseline` | $0.1436 | 398,669 | 7.0 | 52.8 s |
| `multi-mcp-codemode` (hint) | **$0.0808 (−44%)** | 301,491 (−24%) | 5.0 (−29%) | 69.0 s |
| `multi-mcp-block` | $0.1805 (+26%) | 670,335 (+68%) | 12.0 (+71%) | 105.9 s |

**Hint mode delta is *larger* on Opus (−44%) than on Sonnet (−19–30%).** Plausible mechanism: Opus does more upfront planning work, so the cost of one speculative `ToolSearch` is higher per-occurrence. SKILL.md routing text suppresses it; bigger absolute saving.

Block remains net-negative on Opus too (+26% cost), consistent with the Sonnet finding that block is for safety, not performance.

## Cost ledger (this session)

- Pre-tracking estimated sweeps: ~$50 (Opus-dominated)
- Multi-MCP sweeps (N=1 smoke + 3× N=3): ~$2.50
- Block-mode sweeps + diagnostics: ~$1.50
- Session total: **~$55**

Opus-dominated early sweep inflated the total. Sonnet-only runs from commit `e6d4c9f` onward: ~$5 total across all variant-sweep, multi-mcp, and block experiments.
