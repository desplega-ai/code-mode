---
title: Route code-mode output through context-mode's sandbox
date: 2026-04-13
status: idea
---

# Idea — pipe code-mode `run`/`save` output through context-mode

## Context

Live E2E of the plugin tool-bias hooks (plan: `../plans/2026-04-13-plugin-tool-bias-hooks.md`, verified
2026-04-13) surfaced that code-mode and context-mode have complementary, non-overlapping strengths on
`WebFetch`:

- **context-mode** denies `WebFetch` and routes to its sandbox (`ctx_fetch_and_index` / `ctx_execute`)
  so large HTTP payloads never hit the model's context.
- **code-mode** lets `WebFetch` through with a hint pointing at the stdlib `fetch` helper via
  `mcp__plugin_code-mode_code-mode__run` — better for typed, reusable, multi-step data work.

When both plugins are installed, context-mode's deny shadows code-mode's hint on the `WebFetch` path.
That's the right outcome for that specific matcher (sandbox beats raw fetch), but it hides a deeper
opportunity.

## The idea

`code-mode__run` (and to a lesser extent `code-mode__save`'s typecheck stderr) produce script output
that currently flows back into the model's context uncontrolled. If the output is large — a big
JSON payload, a query result, a table — it has the same context-bloat problem context-mode was built
to solve.

Instead of returning that output verbatim, have `code-mode__run` hand it to context-mode's indexer:
index the stdout under a synthetic URL (e.g. `code-mode://run/<script>/<timestamp>`) and return a
short summary + the indexer handle, letting the agent `ctx_search` into it on demand.

## Why it's interesting

- Cohabitation that compounds instead of competes: code-mode gets context-mode's sandboxing for
  free on large outputs; context-mode gets a new ingestion source.
- The existing stdlib helpers (`fetch`, `grep`, `glob`, `table`, `filter`) already produce
  structured output — the indexer handoff is a natural fit.
- Zero agent-side change: the model still calls `__run` as usual, just sees a smaller response when
  the output is large.

## Open questions

- Does context-mode expose a programmatic ingestion API, or only MCP tools? If MCP-only, code-mode
  would need to call it as an MCP client (circular plugin-to-plugin dispatch — possible but messy).
- What's the threshold — always index, or only when stdout > N KB? Small outputs are fine inline.
- Degradation path when context-mode isn't installed: fall back to current behaviour (return
  stdout as-is).
- Does the same apply to `__query_types` / `__list_sdks`? Probably not — those are already small.

## Not in scope now

This is a cross-plugin integration idea, not a planned feature. Capturing it before it's forgotten.
Requires a discovery round on context-mode's ingestion surface before a real plan.
