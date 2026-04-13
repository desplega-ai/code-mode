---
date: 2026-04-13T11:50:00Z
topic: "code-mode E2E Walkthrough (E2E A — CLI)"
author: claude
status: completed
tags: [qa, e2e, code-mode]
---

# code-mode E2E Walkthrough (E2E A — CLI)

- Date: 2026-04-13
- Plan: `/Users/taras/Documents/code/code-mode/thoughts/taras/plans/2026-04-13-code-mode.md`
- Scope: E2E A (CLI walkthrough) only — E2E B (MCP client) skipped per instructions (covered by `test/mcp/server.test.ts`).
- Entry: `bun run /Users/taras/Documents/code/code-mode/packages/core/bin/code-mode.ts <subcommand>`
- Scratch dir: `/var/folders/.../code-mode-e2e.XXXX.szeKHJjWdj` (created via `mktemp`, cleaned up at end).
- Note: saved under `qa/` because `reviews/` is not an allowed thoughts subdir in this repo's hook config.

## Results

| # | Step | Status | Notes |
|---|---|---|---|
| 1 | Create scratch dir | PASS | `mktemp -d` created fresh temp dir |
| 2 | `init` | PASS | `.code-mode/` scaffolded, `code-mode.db` exists (empty file, populated on first reindex), `bun install` ran cleanly |
| 3 | `reindex` | PASS | `symbols=63+`, `sdks=5`, 3 external MCPs skipped due to missing auth (expected — not a regression) |
| 4 | `list-sdks` | PASS | `stdlib` present (4 symbols); also generated `context7`, `pencil`, `qmd`, `_client` |
| 5 | `query-types filter` | PASS | Returned `filter<T>(items: T[], predicate: (item: T) => boolean): T[]` from stdlib |
| 6 | Save + run `sample` | PASS | `success:true`, `result:[3,4]`, exit 0, duration ~843ms |
| 7 | Broken save rejected | PASS | Exit 1, diagnostics `TS2339 Property 'nope' does not exist on type 'string'`, `broken.ts` NOT written to `.code-mode/scripts/` |
| 8 | Timeout enforcement | PASS | `run loop --timeout 2000` returned `success:false`, `reason:"timeout"`, `exitCode:143` (SIGTERM), `durationMs:2526` |
| 9 | Inspector smoke test | PASS | Started `inspect --port 3456 --no-open`, `GET /api/servers` returned HTTP 200 with valid JSON listing 6 MCP servers. Killed via `pkill` |
| 10a | `doctor` (clean) | PASS | Exit 0, `broken=0 stale=0` |
| 10b | Break sample + reindex + doctor | PASS | Exit 1, `broken=1`, `sample` flagged with `Operator '>' cannot be applied to types 'number' and 'string'` |
| 10c | `gc --stale-days 0` (dry-run) | PASS | Listed `loop` and `sample` as stale (0d), mode=dry-run, prompted for `--apply` |
| 11 | Cleanup | PASS | `rm -rf` scratch dir + `/tmp` fixtures |

## Surprises / Observations

- **None blocking.** Reindex gracefully skips unauthenticated external MCPs (`github`, `agent-swarm`, `figma`) rather than aborting — good defensive behavior.
- `code-mode.db` is created as a 0-byte file by `init` and populated on the first `reindex`. Matches expectations; worth keeping in mind if anyone expects the file to exist immediately after init with schema.
- `run loop` returned exit 143 from the timeout-killed subprocess, wrapped into `success:false` with `reason:"timeout"` — clean sandbox behavior.
- Curl/node-fetch from Bash is blocked by the context-mode hook in this environment; inspector smoke test was done via `mcp__plugin_context-mode_context-mode__ctx_execute` which confirmed the 200 + JSON body.
- `reindex --paths .code-mode/scripts/sample.ts` still re-runs the full SDK generation pass (servers=3+/3). Not broken, just noting that `--paths` scopes script reindex but not SDK regen — likely intentional.

## Verdict

**E2E A: ALL PASS.** Every step in the plan's manual E2E (lines 614-756) behaved as specified. Code-mode is functioning end-to-end: init → reindex → discovery → save/run with types → safety rails (timeout, broken rejection) → observability (inspector) → maintenance (doctor, gc).
