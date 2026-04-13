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

Run `code-mode <command> --help` for the full flag list.

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

## Links

- Source: https://github.com/desplega-ai/code-mode
- Issues: https://github.com/desplega-ai/code-mode/issues

MIT © desplega.ai
