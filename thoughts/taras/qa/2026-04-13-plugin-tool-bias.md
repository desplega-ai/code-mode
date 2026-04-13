---
title: QA — plugin tool-bias hooks (Phases 1-6)
date: 2026-04-13
status: machine-verified; live-session items pending
---

# QA — Plugin tool-bias hooks (v0.3.0)

Plan: `thoughts/taras/plans/2026-04-13-plugin-tool-bias-hooks.md`

## Environment
- [x] Claude Code version: 2.1.104
- [x] Machine: macOS 26.4 (darwin 25.4.0), Node v24.14.1, Bun 1.3.11
- [x] `code-mode` plugin version: 0.3.0 (verified via `CODE_MODE_DEV_PATH` dev-mode probe)
- Repo commit tip: `dba849a` (6 unpushed commits on `main`)

## Results (one entry per Manual E2E step from the plan)

### 1. Plugin reload with start.mjs
Status: [ ] pending — live session required (partially verified)

- `node plugins/code-mode/start.mjs --version` → exit 127 with `sh: code-mode: command not found`.
  This is the **documented fallback behavior** when neither `CODE_MODE_DEV_PATH` is set nor the `code-mode` CLI is on PATH nor an `npx` install is reachable; `start.mjs` delegates to `npx` and `npx`'s spawned shell fails to resolve the binary. No network call, no hang.
- Actual `/plugin reinstall` flow inside Claude Code is pending — requires a live session.

### 2. Dev-mode resolver
Status: [x] pass

```
$ bun run --cwd packages/core build   # ok, 50 modules bundled
$ CODE_MODE_DEV_PATH=$PWD/packages/core/dist/cli.js \
    node plugins/code-mode/start.mjs --version
[code-mode] dev path: /Users/taras/Documents/code/code-mode/packages/core/dist/cli.js   # stderr banner
0.3.0                                                                                  # stdout
EXIT=0
```

Stderr banner + stdout version match the expected behavior.

### 3. SessionStart routing prompt visible
Status: [ ] pending — live session required

Hook side verified in full (see item below, "SessionStart hook output"). What remains is confirming Claude Code actually surfaces the `additionalContext` under `SessionStart` in `/debug` transcript — that needs a live session.

### 4. Stdlib auto-seeded
Status: [x] pass

```
$ rm -rf /tmp/cm-qa && mkdir -p /tmp/cm-qa && cd /tmp/cm-qa
$ node /Users/taras/Documents/code/code-mode/packages/core/dist/cli.js init
[code-mode init] scaffolded workspace at /private/tmp/cm-qa/.code-mode
[code-mode init] running 'bun install' in /private/tmp/cm-qa/.code-mode…
+ bun-types@1.3.12
+ typescript@5.9.3
4 packages installed [186.00ms]
[code-mode init] indexed 13 symbols across 1 sdk(s).
[code-mode init] done.

$ ls .code-mode/sdks/stdlib
fetch.ts filter.ts flatten.ts fuzzy-match.ts glob.ts grep.ts table.ts   # 7 files ✓

$ cat .code-mode/config.json
{
  "mcpBlockMode": "hint",
  "mcpWhitelist": [
    "mcp__context7__",
    "mcp__plugin_context-mode_"
  ],
  "hooksEnabled": true
}
```

All three expectations met: 7 stdlib files, `mcpBlockMode=hint`, `hooksEnabled=true`, whitelist covers `context7` and `context-mode` prefixes.

### 5. WebFetch hint fires
Status: [ ] pending — live session required

Hook payload verified in matrix spot-check A (below). Verifying Claude actually reads & acts on the hint requires a live prompt.

### 6. Bash inline-exec soft-block
Status: [ ] pending — live session required

Hook payload verified in matrix spot-check B (below: `ask` + reason recommending `save`). Interactive approval flow requires a live session.

### 7. MCP whitelist + block
Status: [ ] pending — live session required

Hook side fully verified (matrix D/E/F below). `code-mode config set mcpBlockMode block` / `config whitelist add` CLI integration + live MCP tool invocation remain for live session.

### 8. Escape hatch (hook side)
Status: [x] pass

```
$ echo '{"tool_name":"WebFetch","tool_input":{},"session_id":"skip-test"}' \
    | CODE_MODE_SKIP=1 node plugins/code-mode/hooks/pretooluse.mjs
{}        # empty JSON object, exit 0
```

PreToolUse short-circuits to `{}` when `CODE_MODE_SKIP=1`. SessionStart hook confirmed to do the same (see below).

### 9. Dedup
Status: [x] pass

```
$ rm -rf /tmp/cm-qa-dedup && mkdir -p /tmp/cm-qa-dedup
$ echo '{"tool_name":"WebFetch","tool_input":{},"session_id":"qa-test"}' \
    | TMPDIR=/tmp/cm-qa-dedup node plugins/code-mode/hooks/pretooluse.mjs
{"hookSpecificOutput":{...,"permissionDecision":"allow","additionalContext":"code-mode tip: before calling WebFetch..."}}

$ echo '{"tool_name":"WebFetch","tool_input":{},"session_id":"qa-test"}' \
    | TMPDIR=/tmp/cm-qa-dedup node plugins/code-mode/hooks/pretooluse.mjs
{}        # dedup: no hint repeated

$ ls /tmp/cm-qa-dedup/code-mode-hooks-*.json
/tmp/cm-qa-dedup/code-mode-hooks-qa-test.json

$ cat /tmp/cm-qa-dedup/code-mode-hooks-qa-test.json
{"seenTools":{"WebFetch":1776098183804}}
```

State file created with per-session suffix; `seenTools` populated; second call suppressed.

### 10. Reindex hook still works
Status: [ ] pending — live session required

Requires editing a script under `.code-mode/scripts/` in an active Claude Code session and observing that the PostToolUse reindex fires through `start.mjs`. Static inspection of `plugins/code-mode/hooks/` + the confirmed `start.mjs` resolver chain (item 2) gives circumstantial confidence, but the live workspace-edit flow is the real verification.

## Notes / Issues found

### Hook matrix spot-check results (all machine-verified)

| # | Payload                                                                 | Env                     | Expected              | Actual                                                                                                       | Pass |
|---|-------------------------------------------------------------------------|-------------------------|-----------------------|--------------------------------------------------------------------------------------------------------------|------|
| A | `WebFetch` (default config)                                             | default                 | `allow` + fetch-helper hint | `allow`; `additionalContext` references `mcp__plugin_code-mode__code-mode__run` + stdlib `fetch` helper | ✓    |
| B | `Bash` `node -e 'console.log(1)'`                                       | default                 | `ask` + save hint     | `ask`; reason mentions `mcp__plugin_code-mode__code-mode__save` + kebab-case name + PostToolUse reindex     | ✓    |
| C | `Bash` `ls -la`                                                         | default                 | `allow` + generic hint | `allow`; generic "multi-step data transforms → saved code-mode script" hint                                  | ✓    |
| D | `mcp__context7__resolve-library-id` (cwd `/tmp/cm-qa`, default config)  | default                 | `{}` (whitelisted)    | `{}`                                                                                                         | ✓    |
| E | `mcp__github__create_issue` (cwd `/tmp/cm-qa`, default hint config)     | default                 | `allow` + whitelist hint | `allow`; hint includes `code-mode config whitelist add mcp__github__` and `mcpBlockMode=block` upgrade path  | ✓    |
| F | `mcp__github__create_issue`                                             | `CODE_MODE_MCP_BLOCK=1` | `deny` with reason    | `deny`; reason names the tool and offers `CODE_MODE_MCP_BLOCK=0` + `CODE_MODE_SKIP=1` escape                  | ✓    |

### SessionStart hook output

Default (with `CODE_MODE_SKIP` unset) emits `hookSpecificOutput.additionalContext` with the full routing guidance — mentions `__search` / `__run` / `__save`, enumerates all 7 stdlib helpers (`fetch`, `grep`, `glob`, `fuzzy-match`, `table`, `filter`, `flatten`), flags `CODE_MODE_SKIP=1` as escape hatch. With `CODE_MODE_SKIP=1` the hook returns `{}`. Both match expectations.

### Observations / nits

- The `start.mjs` fallback failure (item 1) is cosmetic: `sh: code-mode: command not found` is a shell error surfaced from npx's child process rather than a clear `[code-mode] …` line. Not a bug, but a user debugging a broken install may not immediately know what went wrong. Consider a pre-flight check in `start.mjs` that prints a friendlier hint before handing off to `npx`. Non-blocking.
- `packages/core/dist/cli.js` has to be rebuilt (`bun run --cwd packages/core build`) before the dev-mode probe works — the repo `.gitignore` excludes `dist/`. Expected, but worth calling out for anyone running this QA fresh.
- No surprises in the hook logic: allow/ask/deny decisions match the plan's intent; dedup state file naming follows `$TMPDIR/code-mode-hooks-<session-id>.json` convention.

### Live-session pending summary

Items 1 (partial), 3, 5, 6, 7, 10 require a live Claude Code session. All the **hook-side contracts** these items depend on (PreToolUse JSON payloads, SessionStart routing context, dedup state persistence, escape hatches) are verified. What's left is observing Claude Code actually plumbing those payloads into the transcript and tool-gating layer.

## Sign-off
- [ ] Approved for release
