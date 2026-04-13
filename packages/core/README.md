# code-mode

> CLI + MCP server for typed, reusable script management.

`code-mode` turns throwaway agent scripts into a typechecked, searchable,
reusable library. It indexes the scripts you (or your coding agent) save
under `.code-mode/` into a SQLite+FTS5 store, exposes them as MCP tools,
and keeps the index in lockstep with disk via a Claude Code `PostToolUse`
hook.

## Install

```bash
# one-off (no install)
bunx @desplega/code-mode --help
npx @desplega/code-mode --help

# global — the `code-mode` bin still ends up on PATH
npm i -g @desplega/code-mode
bun add -g @desplega/code-mode

# after a global install, the bin is just `code-mode`:
code-mode --help
```

Requires **Node ≥ 20** or **Bun ≥ 1.1**.

A few commands still need Bun on `PATH`:

- `code-mode init` runs `bun install` inside the scaffolded workspace by
  default — pass `--no-install` if you don't have Bun, and install deps
  yourself afterwards.
- `code-mode run` and `code-mode inspect` spawn TypeScript subprocesses via
  Bun. Without Bun, those two commands error out; everything else
  (`init --no-install`, `save`, `reindex`, `doctor`, `gc`, `mcp`,
  `list-sdks`, `query-types`) works on plain Node.

## Quick start

```bash
# 1. Scaffold a workspace in your project
code-mode init

# 2. Save a script
code-mode save hello --file ./hello.ts

# 3. Run it
code-mode run hello --args '{"name":"world"}'

# 4. Expose the workspace as an MCP server (stdio)
code-mode mcp

# 5. Launch the browser-based inspector
code-mode inspect
```

## Commands

| Command | What it does |
|---|---|
| `init` | Scaffold a `.code-mode/` workspace (config, stdlib, tsconfig). |
| `save <name>` | Persist a script into the workspace index. |
| `run [name]` | Execute a saved or ad-hoc script with timeouts + output caps. |
| `reindex` | Rebuild the SQLite+FTS5 index from disk. Accepts `--paths` for incremental updates. |
| `list-sdks` | List every indexed SDK. |
| `query-types <pattern>` | FTS5 search over indexed symbol signatures. |
| `doctor` | Full-typecheck every script; mark broken ones `unusable`. |
| `gc` | Surface stale / duplicate scripts; `--apply` moves them to `.code-mode/.trash/`. |
| `mcp` | Run code-mode as an MCP server over stdio. |
| `inspect` | Launch the browser-based inspector for configured MCP servers. |
| `config get/set` | Read/write workspace `.code-mode/config.json`. |
| `config whitelist add/remove/list` | Manage the MCP-allow prefix list. |

Run `code-mode <command> --help` for the full flag list.

## Workspace config

`code-mode init` writes `.code-mode/config.json` with sane defaults:

```json
{
  "mcpBlockMode": "hint",
  "mcpWhitelist": ["mcp__context7__", "mcp__plugin_context-mode_"],
  "hooksEnabled": true
}
```

The Claude Code plugin's `PreToolUse` hook reads this file to decide
whether to hint or deny non-whitelisted MCP tool calls. Env overrides:
`CODE_MODE_MCP_BLOCK=1` → force `block`, `CODE_MODE_MCP_BLOCK=0` →
force `hint`, `CODE_MODE_SKIP=1` → bypass all hooks.

## Stdlib helpers

`code-mode init` seeds seven helpers under `.code-mode/sdks/stdlib/`:
`fetch`, `grep`, `glob`, `fuzzy-match`, `table`, `filter`, `flatten`.
`fetch` has 30s timeout + retries + typed JSON parsing; `grep` wraps
ripgrep; `glob` uses `fs.glob` (Node 22+) with a Bun-compatible
fallback.

## Claude Code integration

`reindex --paths <file>` is the cheap seam that keeps the SQLite index
aligned with whatever the agent just wrote. Wire it up as a Claude Code
`PostToolUse` hook so every `Write`/`Edit` under `.code-mode/` triggers an
incremental reindex + typecheck. Broken scripts flip to `status =
'unusable'` immediately and fall out of `search` results, so the agent
doesn't re-discover its own dead code.

A ready-to-paste snippet lives at
[`hooks/post-edit.json`](https://github.com/desplega-ai/code-mode/blob/main/hooks/post-edit.json)
in the repo.

## Runtime caveats

`code-mode run` enforces execution limits via a POSIX shell wrapper:

| Limit | POSIX (macOS/Linux) | Windows |
|---|---|---|
| `--timeout` | ✅ | ✅ |
| `--max-output` | ✅ | ✅ |
| `--max-args` | ✅ | ✅ |
| `--max-memory` (`ulimit -v`) | ✅ Linux honours it; macOS advisory | ❌ |
| `--max-cpu` (`ulimit -t`) | ✅ Linux | ❌ |

`code-mode inspect` spawns the inspector package via Bun. If Bun isn't on
`PATH`, that command is unavailable — the rest of the CLI works on plain
Node.

## Known issues

**`bunx @desplega/code-mode` returns 404 on Bun 1.3.x.** Bun's `bunx`
hits the URL-encoded scoped path (`@desplega%2fcode-mode`) which the
npm registry rejects. Tracked upstream; no workaround inside this
package. Use `npx -y @desplega/code-mode` or `bun add -g
@desplega/code-mode` instead — both resolve the scope correctly.

**`prebuild-install@7.1.3 deprecated` warning on install.** Transitive
dependency of `better-sqlite3`. Cosmetic only; the native addon still
downloads and links successfully. Waiting on `better-sqlite3` to move
off that helper.

## Links

- Source: https://github.com/desplega-ai/code-mode
- Issues: https://github.com/desplega-ai/code-mode/issues

MIT © desplega.ai
