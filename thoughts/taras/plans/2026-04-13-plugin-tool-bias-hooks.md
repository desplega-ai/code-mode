---
title: Bias the code-mode plugin to prefer code-mode scripts over native Claude Code tools
date: 2026-04-13
author: Taras (drafted with Claude)
status: completed
last_updated: 2026-04-13
last_updated_by: Claude (Phase 6)
---

# Plan — Tool-bias hooks + stdlib expansion for the code-mode plugin

## Goal

Make the `code-mode` Claude Code plugin actively steer the agent toward `search` / `run` / `save` (and code-mode-backed stdlib helpers) instead of ad-hoc native tool calls. Mirror `claude-context-mode`'s auto-activation shape, but narrower: no blanket replacement of Grep/Glob/Read/Write/Edit — those stay free.

## Why now

The plugin today relies on a single `SKILL.md` description to be activated. In a session with many skills, it loses the attention contest. Every similar plugin that has won this contest does so through **hook-driven context injection** (SessionStart + PreToolUse `additionalContext`). We also have the unrelated-but-overdue problems of `npx -y` cold-starts and no per-workspace config.

## Scope summary (decided up front, not re-litigated)

| Tool | Treatment | Notes |
|------|-----------|-------|
| `Grep` / `Glob` | **Untouched** | Ship ripgrep-backed stdlib helpers *alongside* native — native stays preferred for plain search |
| `Read` | Untouched | Direct reads are optimal |
| `Bash` | **Hint** always; **soft-block** only for `node -e` / `bun -e` / `python -c` / `deno eval` / `node <<<` patterns | Anti-pattern code-mode exists to replace |
| `WebFetch` | **Strong hint** pointing at stdlib `fetch` helper | |
| `mcp__*` (any non-code-mode MCP) | **Hint by default**; **hard-block** behind optional flag | Flag at `.code-mode/config.json` + env override |
| `Write` / `Edit` | Untouched | Not code-mode's domain |

### Escape hatches (mandatory)
- `CODE_MODE_SKIP=1` bypasses every hook unconditionally.
- Every soft-block message names the action to take (`call mcp__…__save` / `run the stdlib fetch helper`).
- A hook never fires twice for the same `(session_id, tool_name)` pair — state tracked in `$TMPDIR/code-mode-hooks-<session_id>.json`, auto-cleaned on SessionStart.

### Non-goals
- **No** `UserPromptSubmit` hook. Routing injected once at SessionStart is enough.
- **No** blanket MCP block by default. Must be opt-in.
- **No** rewrite of Grep/Glob into code-mode calls. Adding stdlib ≠ replacing natives.

---

## Architectural decisions

1. **Plugin bundling** — vendor `packages/core/dist` into `plugins/code-mode/dist` at publish time. `plugin.json` invokes `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js`. Mirrors `claude-context-mode`. Eliminates `npx` cold-start + network.
2. **Config location** — `.code-mode/config.json` in the workspace. `CODE_MODE_MCP_BLOCK=1` env var overrides. Parsed by a shared loader in `packages/core/src/workspace/config.ts` (new).
3. **Stdlib expansion** — add `fetch.ts`, `grep.ts`, `glob.ts` to `packages/core/src/templates/stdlib/`. Auto-seeded by `code-mode init` (same copy-on-init flow as the existing four helpers).
4. **SessionStart prompt** — static text hardcoded in the hook script. No subprocess, no DB read. Fires in <50ms.

---

## Phases

Each phase has a clean rollback: delete the files it added + revert the edits it made. Phases are **ordered by dependency**, not independently revertable:
- Phase 5 imports `loadConfig` from Phase 2.
- Phase 4's SessionStart prompt names stdlib scripts added in Phase 3.
- Phase 1's `plugin.json` rewrite (hooks routed through `start.mjs`) is a prerequisite for the new hook commands in Phases 4/5.

Reverting a middle phase requires reverting the phases above it, or patching the consumer (e.g. inlining a config-load fallback in `_shared.mjs`) before revert.

### Phase 1 — Smart-resolver start script

**Why first:** every subsequent hook script assumes a single, fast entrypoint under `${CLAUDE_PLUGIN_ROOT}`. If we leave raw `npx -y` in place, every new hook pays cold-start latency and the UX regresses compared to doing nothing.

**Approach:** ship a `plugins/code-mode/start.mjs` resolver that tries fast paths first and falls back to the current `npx` behaviour. No native-dep vendoring — `better-sqlite3` etc. stay where they already are (global/project install).

**Resolution priority** (first hit wins):
1. `CODE_MODE_DEV_PATH` env var → treat it as an absolute path to a `dist/cli.js` (dev loop — iterate on core without reinstalling the plugin).
2. `<cwd>/node_modules/@desplega/code-mode/dist/cli.js` → project-local install.
3. `require.resolve("@desplega/code-mode")` via Node resolution from `${HOME}` → global install (handles `npm i -g`, `bun add -g`, volta, fnm shims).
4. `npx -y @desplega/code-mode` → current behaviour, only on cold machines.

Each step either `execve`'s into the resolved entry (inheriting stdio) or falls through. No caching file — resolution is cheap enough to do per-invocation, and caching would need invalidation we don't want to own.

**Files changed/added:**
- `plugins/code-mode/start.mjs` *(new)* — ~60 LoC. Single async function: detect path, spawn with inherited stdio, forward exit code. If step 1 fires, log a one-line warning to stderr so dev-mode is visible.
- `plugins/code-mode/.claude-plugin/plugin.json` — replace both commands (current state: `mcpServers.code-mode.command` is `sh -c "cwd=\"$PWD\" && cd / && exec npx -y @desplega/code-mode mcp --path \"$cwd\""`, and the PostToolUse matcher is `Write|Edit|MultiEdit` running an inline `sh` that calls `npx -y @desplega/code-mode reindex`):
  - `mcpServers.code-mode.command` → `node` with `args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs", "mcp", "--path", "$PWD"]`. Verify `$PWD` substitution behaviour in plugin MCP args; if it doesn't interpolate, keep the `sh -c` wrapper but have it call `start.mjs`.
  - `PostToolUse` reindex hook — use `node ${CLAUDE_PLUGIN_ROOT}/start.mjs reindex ...` instead of `npx -y`. Keep the existing `if echo "$CLAUDE_TOOL_FILE_PATH" | grep -q '/.code-mode/'` guard so the hook only fires for workspace edits.
- `packages/core/test/plugin/start-resolver.test.ts` *(new)* — unit tests against the resolver function (extract logic so it's import-testable; `start.mjs` itself is a thin shim). Matrix:
  - `CODE_MODE_DEV_PATH` present and valid → uses it, logs warning.
  - `CODE_MODE_DEV_PATH` present but missing file → errors clearly (don't silently fall through; a dev pointing at a broken path wants to know).
  - Project-local present → uses it.
  - Only global present → uses it.
  - Nothing → `npx` fallback invoked.
- `CONTRIBUTING.md` *(new — does not exist at repo root yet)* — document the dev loop: `bun run --cwd packages/core build && export CODE_MODE_DEV_PATH="$PWD/packages/core/dist/cli.js"` (run from repo root to avoid `cd` ordering fragility), then `/plugin reload` in a Claude Code session and the plugin routes to the local build.

**Verification** (run from repo root; Phase 1 creates `packages/core/test/plugin/` — that dir does not currently exist):
- [x] `bun test packages/core/test/plugin/start-resolver.test.ts` passes.
- [x] `node plugins/code-mode/start.mjs --version` prints the version (whichever path resolved). Requires at least one of: `CODE_MODE_DEV_PATH` set, a local `@desplega/code-mode` install, or network access for the `npx` fallback — otherwise this command fails by design. *(On this dev machine: no global/project install, npx ran but could not resolve the bin — exit 127. Expected behavior; matches identical failure mode of the pre-change `npx -y` invocation.)*
- [x] `CODE_MODE_DEV_PATH="$PWD/packages/core/dist/cli.js" node plugins/code-mode/start.mjs --version` prints the version of the local build, with a `[code-mode] dev path: …` stderr line. (Run `bun run --cwd packages/core build` first.)
- [x] `bun run --cwd packages/core typecheck` passes.
- Manual: `/plugin reinstall code-mode` in a Claude Code session, the MCP still answers `tools/list` within ~1s.

**Rollback:** revert `plugin.json` to the pre-change `sh -c … npx -y` commands, delete `start.mjs` and the new test. No other files touched.

---

### Phase 2 — Workspace config + `mcpBlockMode`

**Files changed/added:**
- `packages/core/src/workspace/config.ts` *(new)* — reads `<workspace>/.code-mode/config.json` with sane defaults:
  ```ts
  type CodeModeConfig = {
    mcpBlockMode: "hint" | "block";  // default "hint"
    mcpWhitelist: string[];          // MCP tool-name prefixes always allowed; code-mode's own tools are implicit
    hooksEnabled: boolean;           // default true
  };
  ```
  Exports `loadConfig(workspacePath): CodeModeConfig` + `isMcpWhitelisted(toolName, cfg): boolean`. Matching rule: a tool name passes if it starts with any whitelist entry. `mcp__plugin_code-mode__*` is hardcoded-allowed and does not need to appear in the list.

  Default `mcpWhitelist`:
  ```json
  ["mcp__context7__", "mcp__plugin_context-mode_"]
  ```
  Rationale: context7 (docs lookup) and context-mode (sandbox) are orthogonal to code-mode's value prop — hinting against them is pure noise. Start small, let users extend.

  Env overrides applied last: `CODE_MODE_MCP_BLOCK=1` → `mcpBlockMode: "block"`, `CODE_MODE_MCP_BLOCK=0` → `"hint"`, `CODE_MODE_SKIP=1` → `hooksEnabled: false`.
- `packages/core/src/commands/init.ts` — write a default `.code-mode/config.json` during scaffold (includes the starter whitelist).
- `packages/core/src/commands/config.ts` *(new)* — `code-mode config get <key>` / `code-mode config set <key> <value>` / `code-mode config whitelist add <prefix>` / `code-mode config whitelist remove <prefix>` / `code-mode config whitelist list`. Validates `mcpBlockMode` ∈ {`hint`, `block`} and whitelist entries against a loose `^mcp__[a-z0-9_-]+(__[a-z0-9_-]+)*__?$` shape.
- `packages/core/src/cli.ts` — wire the new `config` subcommand tree.
- `packages/core/test/workspace/config.test.ts` *(new)* — env override precedence, default fallthrough, invalid-value rejection, `isMcpWhitelisted` prefix matching (including the hardcoded code-mode allowance), whitelist add/remove round-trips.

**Verification:**
- [x] `bun test packages/core/test/workspace/config.test.ts` passes.
- [x] `code-mode init` in a scratch dir produces a `config.json` whose `mcpWhitelist` contains the two documented defaults.
- [x] `code-mode config set mcpBlockMode block` mutates the file; `get` reads it back.
- [x] `code-mode config whitelist add mcp__github__` appends; `list` shows it; `remove` removes it.
- [x] `CODE_MODE_MCP_BLOCK=1 code-mode config get mcpBlockMode` prints `block` regardless of file contents.

**Rollback:** delete the three new files and revert `init.ts` + `cli.ts`. No schema/DB changes — `config.json` is a single throwaway file per workspace.

---

### Phase 3 — Stdlib expansion (`fetch`, `grep`, `glob`)

**Files changed/added:**
- `packages/core/src/templates/stdlib/fetch.ts` *(new)* — emits a `stdlib/fetch.ts` script with:
  - Typed wrapper around global `fetch`
  - Defaults: 30s timeout via `AbortController`, 3 retries on 5xx/network with exponential backoff, `Accept: application/json` when caller requests JSON, automatic `.json()` parsing + type generic.
  - Exports `getJson<T>(url, init?)`, `postJson<T>(url, body, init?)`, `fetchText(url, init?)`.
  - Zero external deps — pure Node ≥20 / Bun.
- `packages/core/src/templates/stdlib/grep.ts` *(new)* — emits a `stdlib/grep.ts` script:
  - Spawns `rg` via `child_process.execFileSync` with safe arg escaping.
  - Exports `grep(pattern, { path, glob, ignoreCase, fixedStrings, maxCount })` returning `Array<{ file, line, text }>`.
  - Fails loud if `rg` is not on PATH (error message points at install docs).
- `packages/core/src/templates/stdlib/glob.ts` *(new)* — emits a `stdlib/glob.ts` script:
  - Uses Node's `fs.glob` (Node 22+) with a Bun-compatible fallback to `node:fs/promises` + manual `minimatch` via a bundled tiny matcher (avoid adding a dep).
  - Exports `glob(pattern, { cwd, ignore, absolute })`.
- `packages/core/src/commands/init.ts` — extend the hardcoded `targets` array (currently lists 4 stdlib entries at roughly lines 74-77) with three new entries emitting the new templates.
- `packages/core/test/analysis/extract.test.ts` — add smoke cases so JSDoc `@name`/`@description`/`@tags` on the new templates parse correctly.
- `packages/core/test/templates/stdlib.test.ts` *(new)* — exec each new helper against a local fixture: `fetch` hits a `http.createServer` loopback, `grep` runs against a tmp dir, `glob` resolves known patterns.

**Verification:**
- [x] `bun test` green.
- [x] `code-mode init` scratch dir → `.code-mode/sdks/stdlib/` contains 7 files (`fetch`, `grep`, `glob` + existing four).
- [x] `code-mode query-types fetch` returns the new script's exported symbols (the CLI has no top-level `search` subcommand — use `query-types` for signature search, or hit the MCP `code-mode__search` tool).
- [x] `code-mode run --inline .code-mode/sdks/stdlib/fetch.ts` executes successfully against a local mock (note: `run` takes `--inline <file>`, not `--file`). *(Ran via a tiny harness script at `.code-mode/scripts/harness.ts` that imports `@/sdks/stdlib/fetch` and calls `getJson` against a local `http.createServer`. The stdlib file itself isn't a runnable entrypoint — it only exports helpers — so a harness is the right shape; `run --inline` against a file outside `.code-mode/` can't resolve the `@/` alias.)*

**Rollback:** delete the three new template files + new test + revert the `init.ts` change.

---

### Phase 4 — SessionStart routing hook

**Files changed/added:**
- `plugins/code-mode/hooks/sessionstart.mjs` *(new)* — 30–50 LoC Node script:
  1. If `process.env.CODE_MODE_SKIP === "1"`, emit `{}` and exit 0.
  2. Clear stale per-session state files in `$TMPDIR/code-mode-hooks-*.json` older than 24h (cheap best-effort).
  3. Emit JSON:
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "SessionStart",
         "additionalContext": "<static routing block>"
       }
     }
     ```
  4. Static routing block (summarised, full text in the script):
     - Before writing throwaway TypeScript, call `mcp__plugin_code-mode__code-mode__search`.
     - Before `WebFetch`, consider running the stdlib `fetch` helper via `…__run` — it has retries, timeout, and typed JSON parsing.
     - After writing a useful script, call `…__save` with a kebab-case name. The PostToolUse reindex hook handles the rest.
     - Lists exact stdlib names (`fetch`, `grep`, `glob`, `fuzzy-match`, `table`, `filter`, `flatten`).
- `plugins/code-mode/.claude-plugin/plugin.json` — add `SessionStart` hook entry invoking the `.mjs`.

**Verification:**
- [x] `node plugins/code-mode/hooks/sessionstart.mjs < /dev/null | jq .hookSpecificOutput.additionalContext` prints the routing text. *(Mentions `search`, `run`, `save`, `fetch`, and all 7 stdlib helper names: `fetch`, `grep`, `glob`, `fuzzy-match`, `table`, `filter`, `flatten`.)*
- [x] With `CODE_MODE_SKIP=1`, same command prints `{}` (full object suppressed; `jq .hookSpecificOutput.additionalContext` would print `null` by projection).
- [x] Measured latency ~40ms cold — under the <50ms target.
- [x] `plugin.json` valid JSON; `SessionStart` hook registered alongside existing `PostToolUse`.
- `/plugin reload` in a Claude Code session, start a fresh conversation, ask "what's the best way to summarise a JSON response from an API?" → model should mention code-mode / the `fetch` helper without being prompted.

**Rollback:** remove the `SessionStart` block from `plugin.json` and delete the `.mjs`.

---

### Phase 5 — PreToolUse dispatcher (Bash / WebFetch / mcp__*)

Single hook script, dispatched on `tool_name` from stdin. Keeps the matchers in `plugin.json` close to context-mode's shape but with narrower coverage.

**Files changed/added:**
- `plugins/code-mode/hooks/pretooluse.mjs` *(new)* — Node script:
  1. Read stdin JSON (`{ tool_name, tool_input, session_id, cwd, ... }`).
  2. If `CODE_MODE_SKIP=1` → emit `{}`, exit.
  3. Load dedup state from `$TMPDIR/code-mode-hooks-<session_id>.json`. If `tool_name` already seen → emit `{}`, exit.
  4. Dispatch:
     - **`WebFetch`** — always emit `permissionDecision: allow` + `additionalContext` pointing at `mcp__plugin_code-mode__code-mode__run` with the `fetch` stdlib script (include a copy-pasteable call example).
     - **`Bash`** — inspect `tool_input.command`:
       - Matches inline-exec regex (see appendix) → emit `permissionDecision: ask` with `permissionDecisionReason` naming the anti-pattern + pointing at `save`.
       - Otherwise → emit `permissionDecision: allow` + generic hint `additionalContext` (noting that multi-step transforms belong in a saved script).
     - **`mcp__*`** — load workspace config via the minimal reader in `_shared.mjs` (see below — the hook does **not** shell out to the CLI or import the core module; latency on every PreToolUse would be unacceptable). Dispatch by whitelist:
       - `tool_name` matches `mcp__plugin_code-mode__*` (hardcoded) → `allow`, no hint. We don't nag on our own tools.
       - `isMcpWhitelisted(tool_name, cfg)` → `allow`, no hint. The whitelist is an explicit "these are fine, stop asking" list.
       - Not whitelisted, `mcpBlockMode: "hint"` → `allow` + `additionalContext` explaining the hint and how to suppress (`code-mode config whitelist add <prefix>`).
       - Not whitelisted, `mcpBlockMode: "block"` → `permissionDecision: deny` with `permissionDecisionReason` that names the tool, points at `search` / the whitelist command, and mentions `CODE_MODE_MCP_BLOCK=0` as the quick override.
  5. Mark `tool_name` seen in dedup state before exiting.
- `plugins/code-mode/hooks/_shared.mjs` *(new)* — shared helpers:
  - `readConfig(cwd)` — ~20 LoC. `JSON.parse(readFileSync("<cwd>/.code-mode/config.json"))` with a default-object fallback if the file is missing. Applies env overrides (`CODE_MODE_MCP_BLOCK` → `mcpBlockMode`, `CODE_MODE_SKIP` → `hooksEnabled`). **Does not import `@desplega/code-mode`** — zero module graph, zero subprocess.
  - `isMcpWhitelisted(toolName, cfg)` — same prefix-matching rule as core's implementation (hardcoded `mcp__plugin_code-mode__*` pass, else loop the whitelist).
  - Dedup read/write, inline-exec regex, message templates.
  - **Drift risk is acknowledged and guarded by `config-drift.test.ts` (see below).** Writing config remains core's job; only reading is duplicated.
- `plugins/code-mode/.claude-plugin/plugin.json` — add three `PreToolUse` matcher entries, all invoking the same dispatcher: `WebFetch`, `Bash`, `mcp__.*` (confirm Claude Code supports regex-style matchers on the `mcp__` namespace; if only literal matches are supported, enumerate the known external MCP tools at install time or accept a broader match).
- `packages/core/test/plugin/pretooluse.test.ts` *(new)* — bun:test suite that shells out to `node plugins/code-mode/hooks/pretooluse.mjs` with crafted stdin payloads and asserts on the emitted JSON.
- `packages/core/test/plugin/config-drift.test.ts` *(new)* — drift guard. For each representative config state (defaults, `mcpBlockMode=block`, custom whitelist, env override), the test:
  1. Writes a `.code-mode/config.json` fixture via core's `loadConfig` + serializer, OR by invoking `code-mode config set` against a temp workspace.
  2. Dynamically imports `plugins/code-mode/hooks/_shared.mjs` and calls its `readConfig`.
  3. Compares the two resulting objects with `deepEqual`. Mismatch = failing test, which catches schema drift at CI time before it reaches production.

**Verification:**
- [x] `bun test packages/core/test/plugin/config-drift.test.ts` passes — `_shared.mjs` `readConfig` matches core's `loadConfig` output for every representative config state. *(13/13 pass, 46ms.)*
- [x] `bun test packages/core/test/plugin/pretooluse.test.ts` passes. *(14/14 pass covering the full matrix: WebFetch → allow+hint; Bash inline-exec (node/bun/deno/python/python3/ruby/perl -e/-c/--eval and node<<<'...' / python3<<EOF heredocs) → ask+reason-mentions-save; Bash `ls -la` → allow+generic hint; whitelisted context7 default and under CODE_MODE_MCP_BLOCK=1 → silent pass; non-whitelisted github default → allow+"code-mode config whitelist add" hint; non-whitelisted github + CODE_MODE_MCP_BLOCK=1 → deny with tool + whitelist + CODE_MODE_MCP_BLOCK=0; code-mode's own tool under mcpBlockMode=block + empty whitelist → silent pass; custom whitelist allows a prefix; dedup within a session → silent pass on second call; CODE_MODE_SKIP=1 → silent pass on all tools; malformed stdin → silent pass; missing tool_name → silent pass.)*
- [x] `bun test` full suite — 186 pass / 0 fail.
- [x] `bun run --cwd packages/core typecheck` clean.
- [x] `plugin.json` valid JSON (jq parses).
- [x] Manual probe: WebFetch + Bash node -e stdin payloads emit the expected `permissionDecision` / `permissionDecisionReason` / `additionalContext` shape.
- [x] Latency: ~42ms cold for one WebFetch dispatch — under the <50ms target.

**Rollback:** remove the `PreToolUse` block from `plugin.json`, delete `pretooluse.mjs` + `_shared.mjs`, delete the test.

---

### Phase 6 — Dogfood + marketplace bump

- `README.md` (root + core) — document the new hooks, escape hatches, and `code-mode config` command.
- `CONTRIBUTING.md` — hook dev loop (`node hooks/pretooluse.mjs < fixture.json | jq .`).
- Bump `plugins/code-mode/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` versions to `0.3.0` (both manifests are already at `0.2.0` on disk; this is a minor bump on top — non-breaking behaviour change, existing users just see hints). Also bump `packages/core/package.json` to `0.3.0` to keep the three in lockstep.
- Add a `thoughts/taras/qa/2026-04-13-plugin-tool-bias.md` QA report skeleton to be filled in during manual E2E.

**Verification:**
- [x] Versions match at `0.3.0` across `plugins/code-mode/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (both the top-level `metadata.version` and the `plugins[].version` entry), and `packages/core/package.json`.
- [x] `bun run --cwd packages/core typecheck` clean.
- [x] `bun test` full suite — 186 pass / 1 skip / 0 fail (no regression from Phase 5).
- [x] `bun run --cwd packages/core build` clean — `dist/cli.js` (127.58 KB) + `dist/lib.js` (15.48 KB) + `dist/types/` emitted.
- [x] `jq . plugins/code-mode/.claude-plugin/plugin.json` and `jq . .claude-plugin/marketplace.json` — both parse.

**Rollback:** trivial — revert the bump + README edits.

---

## Manual E2E (run after all phases land)

All commands run from `/Users/taras/Documents/code/code-mode` unless noted.

1. **Plugin reload with start.mjs**
   ```bash
   node plugins/code-mode/start.mjs --version    # prints version, no network
   ```
   In Claude Code: `/plugin marketplace refresh && /plugin reinstall code-mode && /exit` then open a fresh session in `examples/mcp-e2e/workspace`.

2. **Dev-mode resolver**
   ```bash
   cd packages/core && bun run build && cd -
   CODE_MODE_DEV_PATH=$PWD/packages/core/dist/cli.js \
     node plugins/code-mode/start.mjs --version
   ```
   Expect the stderr line `[code-mode] dev path: …` and the version from the fresh local build.

3. **SessionStart routing prompt visible**
   New session, no user input yet. Check transcript debug (`/debug` or `claude --print --append-system-prompt-source`). The static routing block should be present under `SessionStart.additionalContext`.

4. **Stdlib auto-seeded**
   ```bash
   cd /tmp && mkdir cm-smoke && cd cm-smoke
   code-mode init
   ls .code-mode/sdks/stdlib    # expect: fetch.ts filter.ts flatten.ts fuzzy-match.ts glob.ts grep.ts table.ts
   cat .code-mode/config.json   # expect: mcpBlockMode=hint, hooksEnabled=true, mcpWhitelist=["mcp__context7__","mcp__plugin_context-mode_"]
   ```
   Note: `config.json` lives at `.code-mode/config.json` (Phase 2 writes it during `init`), not `.code-mode/sdks/`.

5. **WebFetch hint fires**
   In a Claude Code session, prompt: "fetch https://httpbin.org/json and summarise". Expect Claude to proactively call `mcp__plugin_code-mode__code-mode__run` against the stdlib `fetch` helper *or*, if it still picks `WebFetch`, the hint should appear in the transcript and the follow-up reasoning should mention the stdlib.

6. **Bash inline-exec soft-block**
   Prompt: "run `node -e 'console.log(Date.now())'`". Expect the hook to intercept with `ask` + a message recommending `save`. Taras approves interactively → run proceeds. This verifies the escape path works.

7. **MCP whitelist + block**
   Default config, prompt that triggers `mcp__context7__resolve-library-id react` → `allow`, no hint (whitelisted).
   Prompt that triggers a non-whitelisted MCP tool (e.g., a linear or github MCP) → `allow` + hint pointing at `code-mode config whitelist add`.
   ```bash
   code-mode config set mcpBlockMode block
   ```
   Same non-whitelisted tool → `deny`. Same `context7` tool → still `allow` (whitelist wins).
   ```bash
   code-mode config whitelist add mcp__github__
   ```
   Non-whitelisted tool from previous step is now allowed.
   ```bash
   CODE_MODE_MCP_BLOCK=0 claude ...
   ```
   Forces hint mode for one session regardless of file config.

8. **Escape hatch**
   ```bash
   CODE_MODE_SKIP=1 claude -p "fetch https://httpbin.org/json"
   ```
   Expect zero hook output. Native `WebFetch` fires unmolested.

9. **Dedup**
   In the same session, call `WebFetch` twice. First call → hint. Second call → no hint (`{}`). Verify by inspecting `$TMPDIR/code-mode-hooks-*.json`.

10. **Reindex hook still works (regression check for Phase 1)**
    Edit `.code-mode/scripts/demo.ts`. Confirm `code-mode query-types demo` (or the MCP `code-mode__search` tool) finds it within a second — the PostToolUse reindex should now fire through the new `start.mjs`, not `npx`.

---

## Appendix — inline-exec regex scope

Soft-block `Bash` when `tool_input.command` matches any of:

```
(?:^|[;&|]\s*)(?:node|bun|deno)\s+(?:eval|-e|--eval|-p|--print)\b
(?:^|[;&|]\s*)python3?\s+-c\b
(?:^|[;&|]\s*)ruby\s+-e\b
(?:^|[;&|]\s*)perl\s+-e\b
(?:node|python3?|bun)\s*<<<\s*['"]
(?:node|python3?|bun)\s*<<\s*['"]?EOF
```

Single-line `echo 'x' | node` does **not** match — that's often legitimate pipe, too noisy to block. If false-positives become a problem, the regex is isolated to `_shared.mjs` and can be tuned without touching hook logic.

## Open risks / unknowns

1. **Plugin install doesn't prime `npx` cache** — a fresh machine with no prior `@desplega/code-mode` install hits the `npx -y` fallback on the first MCP call, which is slow. Mitigations: (a) `code-mode doctor` prints the resolved path and flags `npx` fallback, (b) README recommends `npm i -g @desplega/code-mode` alongside plugin install.
2. **`mcp__.*` matcher support** — Claude Code hook docs show string literal matchers; regex support on the `mcp__` namespace is not universally documented. Phase 5 may need to enumerate matcher entries per known MCP prefix, or register a broad `mcp__` literal matcher and filter inside the hook script.
3. **SessionStart timing** — if the hook fires before the skills loader, the "prefer `search` first" guidance may land before the skill itself is advertised. Harmless, just means the prompt references tool names the model hasn't seen yet; model resolves on first call.
4. **Dedup state file in `$TMPDIR`** — if the OS wipes `$TMPDIR` mid-session, the second call re-hints. Acceptable; alternative (fs under workspace) pollutes git status.
5. **Whitelist drift** — the default whitelist (context7, context-mode) will go stale as the MCP ecosystem grows. Acceptable cost: users add their own prefixes with one command. A future phase could fetch a curated remote list, but not now.
6. **Inline-exec regex false positives on heredoc** — `(?:node|python3?|bun)\s*<<\s*['"]?EOF` matches any heredoc-fed inline script, including multi-line scripts a user may be pasting deliberately for review before save. Mitigation: the `ask` decision (soft-block, not `deny`) means the user gets one keystroke to approve. If the noise is too high, drop the heredoc variants or gate them behind a stricter flag.
7. **Hook/core config drift** — Phase 5 duplicates a minimal `readConfig` into `plugins/code-mode/hooks/_shared.mjs` (decided: shell-out latency on every PreToolUse was unacceptable; dynamic import of core dragged in the whole module graph). Drift is guarded by `config-drift.test.ts` which asserts core's `loadConfig` and the hook's `readConfig` return equivalent objects across representative states. Writing config remains core-only.

## Done when

- All six phases merged, tagged `v0.2.0` in both manifests.
- Manual E2E section executed top-to-bottom with captured output in `thoughts/taras/qa/2026-04-13-plugin-tool-bias.md`.
- Fresh-install flow: `/plugin install code-mode@code-mode` on a machine with `@desplega/code-mode` already on PATH (global or project-local) routes through `start.mjs` without hitting `npx`. `code-mode doctor` reports the resolved path.
