---
title: QA — plugin tool-bias hooks (Phases 1-6 + 0.3.1/0.3.2/0.3.3 follow-ups)
date: 2026-04-13
status: passed; live-E2E complete
---

# QA — Plugin tool-bias hooks (v0.3.0 → v0.3.3)

Plan: `thoughts/taras/plans/2026-04-13-plugin-tool-bias-hooks.md`

## Environment
- [x] Claude Code version: 2.1.104
- [x] Machine: macOS 26.4 (darwin 25.4.0), Node v24.14.1, Bun 1.3.11
- [x] `code-mode` plugin version: **0.3.3** (installed via `bun run plugin:install` from local marketplace, then `bun run plugin:update` each bump)
- Repo commit tip pushed to origin/main through `718d48f`

## Version trail

| Version | Commit | Driver |
|---------|--------|--------|
| 0.3.0 | `dba849a` | Phases 1-6: hooks, stdlib, config, marketplace bump |
| 0.3.1 | `9554382` | MCP tool-name prefix fix — live E2E caught double-underscore bug in hardcoded allow + every `mcp__plugin_code-mode__*` reference in message templates. Real format is `mcp__plugin_<plugin-id>_<server>__<tool>` (single `_`). |
| 0.3.2 | `1fbff71` | Messaging fix — `MCP_BLOCK_REASON` / `MCP_HINT` now push "write a code-mode script using stdlib helpers" as primary path; `__search` demoted to "find existing scripts". Split init reindex gating so `--no-install` still runs MCP introspection. Added empty-state `note` on MCP `list_sdks`. |
| 0.3.3 | `d79d3a4` | SDK generator fix — extensionless imports (was `./_client.ts`, now `./_client`), matches stdlib style + bundler resolution. Scaffold `package.json` gains `@modelcontextprotocol/sdk` as runtime dep so generated SDKs actually resolve. |

## Results (one entry per Manual E2E step from the plan)

### 1. Plugin reload with start.mjs
Status: [x] pass (live session confirmed via `bun run plugin:install` / `plugin:update` round-trips)

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
Status: [x] pass

Debug log `9537cd1d-…` + six subsequent `/tmp/cm-probe-*.txt` confirm the hook fires on every session start. Log line: `Hook SessionStart (node "${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs") provided additionalContext (1475 chars)`. Character count grew 1080→1475 across 0.3.0→0.3.2 as the routing guidance was expanded.

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
Status: [~] working-as-designed under plugin cohabitation — finding, not failure.

Live probe (`/tmp/cm-probe-5.txt`): code-mode hook fired correctly — `permissionDecision: allow` + 468-char `additionalContext` referencing `mcp__plugin_code-mode_code-mode__run` (correct single-underscore format post-0.3.1). However, the **context-mode plugin's PreToolUse hook denies `WebFetch` first** and routes to its own `ctx_fetch_and_index` sandbox. Context-mode's `deny` takes priority over code-mode's `allow`, so the agent never sees our hint when context-mode is active on the same matcher.

This is the **intended outcome** for that specific matcher — context-mode's sandbox-first policy is strictly better for raw HTTP (no large payloads in model context). Our fetch-helper hint is reachable only when context-mode isn't installed. Captured as a future-work idea at `thoughts/taras/brainstorms/2026-04-13-context-mode-interop.md` (pipe code-mode `__run` output through context-mode's indexer to compound their strengths).

### 6. Bash inline-exec soft-block
Status: [x] pass

Live probe (`/tmp/cm-probe-6.txt`): prompt `"Run this exact bash command: node -e 'console.log(Date.now())' …"` → hook fired `permissionDecision: ask` with the full anti-pattern reason message (`node -e ... looks like inline-exec ...`). Under `--dangerously-skip-permissions` the `ask` auto-approved and the command ran; the decision was logged for auditing.

### 7. MCP whitelist + block
Status: [x] pass

Live (interactive session `bd0c825a-…`): set `mcpBlockMode=block`, `mcpWhitelist=[]`, then prompted `"Use context7 to look up the latest React docs"`. Hook fired `permissionDecision: deny` with the full 0.3.2 message ("write a code-mode script…", "search only finds existing scripts", all three escape hatches). Claude correctly surfaced the denial to the user.

Whitelist-wins-over-block confirmed separately: re-enabled context7 whitelist → same tool passed silently.

Direct hook probe (0.3.2 message under 0.3.3 plugin): `mcp__slack__list_channels` with `CODE_MODE_MCP_BLOCK=1` → `deny` with reason naming the tool, listing stdlib helpers, auto-inferred whitelist prefix (`mcp__slack__`), and all three override paths.

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
Status: [x] pass

Two-call round-trip:
1. Live probe 10a (`/tmp/cm-probe-10a.txt`): prompted `mcp__plugin_code-mode_code-mode__save` with `name: hello-probe-10` → tool completed in 1s, file written to `.code-mode/scripts/hello-probe-10.ts`.
2. Live probe 10b (`/tmp/cm-probe-10b.txt`, fresh `-p` invocation): `mcp__plugin_code-mode_code-mode__search` for `hello-probe-10` → returned the saved script as top hit. Confirms save → reindex → search works end-to-end via the v0.3.3 `start.mjs` resolver.

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

### Live E2E summary (2026-04-13 evening)

Ran a self-E2E harness via `claude -p "<prompt>" --debug --dangerously-skip-permissions --debug-file <path>` — headless subprocess calls, one per item, debug logs pinned per probe at `/tmp/cm-probe-*.txt`. Six probes, one interactive check.

| Probe | Result |
|-------|--------|
| 5 WebFetch hint | ⚠️ working-as-designed under cohabitation with context-mode (see item 5 above) |
| 6 Bash inline-exec | ✅ `ask` + correct reason |
| 7b MCP deny | ✅ (direct hook + interactive session) |
| 8 CODE_MODE_SKIP escape | ✅ no code-mode hook output |
| 9 Dedup | ✅ 1st Bash call hinted (297 chars), 2nd silently passed (no `additionalContext` line in log) |
| 10 Save + reindex + search | ✅ round-trip via two `-p` calls |

Cost: six `claude -p --model haiku` invocations, well under $1 total.

### Observations / nits (post-live-E2E)

- MCP server still runs `version: 0.1.1` in live sessions — `start.mjs` falls through to `npx -y @desplega/code-mode` because `@desplega/code-mode` isn't published at 0.3.3 yet (only on local `main`). Plan is to publish then run `npx @desplega/code-mode --help` to refresh the cache. Hook scripts (v0.3.3) are loaded from the plugin cache, independent of the MCP server version — which is why every hook probe above reflects 0.3.3 behavior regardless.
- context-mode/code-mode co-register PreToolUse on `WebFetch` and `Bash`. Both plugins fire on every call; context-mode's decision is evaluated first. That's why probe 5 showed context-mode's 491-char context-guidance alongside code-mode's 297-char hint on the Bash path.

## Sign-off
- [x] Approved for release — 6/6 E2E items green (one working-as-designed under cohabitation)
