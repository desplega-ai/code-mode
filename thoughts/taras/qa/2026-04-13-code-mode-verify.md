---
date: 2026-04-13
author: Claude (desplega:verifying, autopilot)
topic: "code-mode post-implementation audit"
plan: thoughts/taras/plans/2026-04-13-code-mode.md
status: complete
---

# code-mode — Post-Implementation Verification

> Saved under `qa/` because the thoughts-validation hook disallows `reviews/`.

## Overall

Complete. All 9 phases implemented, test suite green (`bun test` at root: **102 pass / 1 skip / 0 fail**, 327 expect() calls across 21 files, 10.78s). Typecheck clean in both `packages/core` and `packages/inspector`. The three documented deviations (standalone FTS, Linux-gated memory test, vanilla-HTML inspector) are all reasonable and reflected in the code.

## Per-Phase Status

### Phase 1 — Bootstrap + CLI skeleton — PASS
- Monorepo root + `packages/core/{bin,src}` present.
- `bun run packages/core/bin/code-mode.ts --help` lists all expected subcommands (plus `inspect` added in Phase 9): `init`, `mcp`, `run`, `save`, `reindex`, `list-sdks`, `query-types`, `doctor`, `gc`, `inspect`.
- `packages/core/src/cli.ts` present; command stubs promoted to real handlers in later phases.
- `tsconfig.json` + strict typecheck clean.

Deviation vs. plan: commands `list-sdks` and `query-types` surfaced as standalone CLI commands (plan only listed them implicitly under Phase 4). Matches Phase 4's intent ("useful for manual testing before MCP wiring"). Fine.

### Phase 2 — init + workspace scaffolding + stdlib — PASS
- `packages/core/src/commands/init.ts` present.
- Templates: `packages/core/src/templates/{tsconfig.json.ts, package.json.ts}` + 4 stdlib files (`filter.ts`, `flatten.ts`, `fuzzy-match.ts`, `table.ts`).
- Workspace layout (`scripts/`, `sdks/stdlib/`, `sdks/.generated/`, `code-mode.db`) written at init time. Confirmed by existing `test/fixtures/minimal-workspace/`.

### Phase 3 — Type analysis (ts-morph wrapper) — PASS
- `packages/core/src/analysis/{project,typecheck,extract}.ts` all present.
- Analysis tests green.

### Phase 4 — Storage + FTS5 + reindex + list_sdks + query_types — PASS (with known deviation)
- `packages/core/src/db/{migrate,repo,schema}.ts` + `migrations/001_initial.sql`.
- `packages/core/src/index/reindex.ts`, `queries/{listSdks,queryTypes,search}.ts`.
- **Deviation (documented inline in migration file)**: `scripts_fts` and `symbols_fts` are standalone FTS5 tables (not `content=scripts` / `content=symbols`). Reasoning written into `001_initial.sql` comments — `scripts_fts` needs a synthetic `signatures` column that doesn't exist on `scripts`, and standalone tables simplify the write path at MVP scale. Query paths in `src/queries/*` and `src/mcp/handlers/*` work correctly against this — 102 passing tests exercise it end to end.
- All 8 automated checkboxes pass when re-run.

### Phase 5 — run + save + execution limits — PASS (with platform skip)
- `packages/core/src/commands/{run,save}.ts` present.
- `packages/core/src/runner/{loader,limits,exec}.ts` present. `limits.ts` exposes `DEFAULT_LIMITS` with `maxOutputBytes: 1_000_000`, `maxArgsBytes: 256 * 1024`, timeout/CPU/memory all per plan.
- **Deviation (documented in plan already)**: memory cap test is gated via `test.skipIf(process.platform !== "linux")` in `test/runner/exec.test.ts:227` — confirmed present and the single `skip` in the test-suite total reflects this on darwin. Reasonable: macOS `ulimit -v` is advisory.
- Remaining 7 automated checkboxes pass.

### Phase 6 — MCP SDK generator — PASS
- `packages/core/src/sdk-gen/{config,introspect,codegen,emit,index}.ts` all present.
- Emit writes `_client.ts` + per-server `<server>.ts`, wipes `.generated/` before rewriting, idempotent.
- sdk-gen tests green.

### Phase 7 — MCP server mode — PASS
- `packages/core/src/mcp/server.ts` registers all 5 tools at the expected names: `search` (line 137), `run` (160), `save` (189), `list_sdks` (205), `query_types` (214).
- Handlers delegated to `src/mcp/handlers/{search,run,save,listSdks,queryTypes}.ts`.
- `src/commands/mcp.ts` wires stdio transport.
- MCP integration suite green (log line `[code-mode mcp] listening on stdio (workspace=...)` appears in the test run output, confirming subprocess spin-up works).

### Phase 8 — doctor + gc + broken-script hook + starter templates — PASS
- `packages/core/src/commands/{doctor,gc}.ts` present.
- `hooks/post-edit.json` present at repo root — not baked in, documented as plan specifies. Matcher `Write|Edit|MultiEdit`, guards with `grep '/.code-mode/'`, calls `bunx -p code-mode code-mode reindex --paths "$CLAUDE_TOOL_FILE_PATH"`. Matches the plan's "ship a hooks/post-edit.json example snippet".
- **Starter templates opt-in**: `packages/core/src/sdk-gen/emit.ts` exposes `templates?: boolean` (line 32) in `EmitOptions`, gated by `wantTemplates = opts.templates !== false && opts.scriptsDir !== undefined` (line 99). Default on, explicit `--no-templates` opt-out wiring present. Matches plan.
- doctor/gc tests green.

### Phase 9 — Web inspector — PASS (with known deviation)
- Monorepo pivot done: root `package.json` has `workspaces: ["packages/*"]`.
- `packages/inspector/{bin/inspector.ts, server/{server,invoke,ui}.ts, test/{server,ui}.test.ts, public/, ui/src/}` — `ui/src/` is intentionally empty.
- **Deviation (documented in autopilot report)**: inspector UI is vanilla HTML rendered server-side by `packages/inspector/server/ui.ts` (`<!doctype html>` template at line 14–59) rather than Vite+React. Confirmed `ui/src/` empty, no React/Vite dependency, no bundler step. `server.ts` (`content-type: text/html`, line 96) serves the HTML inline. Reasonable — dramatically smaller surface for MVP, no bundler cold-start.
- **Workspace imports**: grepped repo for `workspace:*` — zero matches. Inspector references core via relative paths. Reasonable given Bun supports workspace resolution either way, and relative imports keep `bun test` from needing install-time symlink tricks.
- `packages/core/src/commands/inspect.ts` present (delegates to the inspector workspace).
- All 4 inspector automated checkboxes pass.

## Top-of-Repo Verification

- `bun test` (root): **102 pass, 1 skip, 0 fail**, matches expected count exactly.
- `cd packages/core && bun run typecheck` → clean.
- `cd packages/inspector && bun run typecheck` → clean.
- CLI help output shows all 10 expected subcommands.

## Deviations Summary

| Deviation | Documented? | Reasonable? |
|---|---|---|
| Standalone FTS5 tables (no `content=`) | Yes — inline in `001_initial.sql` | Yes — `signatures` column is synthetic; MVP scale doesn't need external-content |
| Linux-gated memory test | Yes — noted in plan Phase 5 itself (macOS `ulimit -v` advisory) | Yes — keeps macOS CI honest |
| Inspector UI is vanilla HTML, not Vite+React | Yes — per autopilot report | Yes — MVP inspector is read-plus-invoke, simple HTML is enough |
| Workspace imports are relative, not `workspace:*` | Yes — per autopilot report | Yes — Bun resolves both; relative paths avoid install-time coupling |
| `list-sdks` / `query-types` as CLI commands | Implicit in plan Phase 4 | Yes — matches "useful for manual testing" note |

## Missing Pieces

None. Every `Changes` bullet in the plan maps to a file on disk, every automated `[x]` checkbox passes when re-run, and the 5 MCP tools + CLI subcommands are all wired.

Items not exercised (plan only listed them as *manual* verification, so not a gap):
- Running `code-mode inspect` against a real `.mcp.json`.
- Registering `code-mode mcp` with Claude Code and driving via an agent.
- End-to-end install via `bun install -g code-mode`.

These belong to the "Manual E2E Walkthrough" section of the plan, which is user-driven by design.

## Recommendations

1. **Promote inline FTS deviation into plan body (follow-up edit)**: the `001_initial.sql` comment block explains it well, but the plan itself still shows `content=scripts` in its spec. If the plan is canonical for future maintainers, update Phase 4 text to reflect the standalone-FTS decision so the code/plan don't drift.
2. **Consider the Windows gap**: plan risks table already flags no `ulimit` on Windows. No code change needed, but it may be worth a one-liner in `README.md` or `docs/scripts.md` so first-time Windows users know timeout + output cap still apply.
3. **Vanilla-HTML inspector is a net positive** (smaller install, no bundler) — recommend sticking with it even for post-MVP unless a real UX need for React shows up. Update the plan's Phase 9 text to match reality.
4. **Root-level `bun test` monorepo discovery**: tests live inside each package (`packages/*/test/`). Bun's monorepo-aware `bun test` discovers them all. A one-liner note in `README.md` about how to run per-package would future-proof onboarding.

No blocking findings. MVP is feature-complete per the plan.
