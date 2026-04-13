# code-mode

> **Experimental** — `0.x`. The API (CLI flags, MCP tool shapes, library exports) may change between minor releases until `1.0`.
>
> CLI + MCP server for typed, reusable script management.

`code-mode` turns throwaway agent scripts into a typechecked, searchable,
reusable library. The CLI indexes scripts you (or your coding agent) save
under `.code-mode/` into a SQLite+FTS5 store, exposes them as MCP tools,
and keeps the index in lockstep with disk via a Claude Code `PostToolUse`
hook.

- **Published package:** [`@desplega/code-mode`](https://www.npmjs.com/package/@desplega/code-mode) on npm
- **Package source:** [`packages/core`](./packages/core)

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

Requires **Node ≥ 20** or **Bun ≥ 1.1**. Some commands (`run`, `inspect`)
spawn TypeScript directly and will use Bun if it's on `PATH`.

## Quick start

```bash
code-mode init                               # scaffold .code-mode/
code-mode save hello --file ./hello.ts       # persist a script
code-mode run hello --args '{"name":"x"}'    # execute it
code-mode mcp                                # expose as MCP server (stdio)
code-mode inspect                            # browser inspector
```

Full command reference lives in [`packages/core/README.md`](./packages/core/README.md).

## Claude Code integration

`code-mode reindex --paths <file>` is the cheap seam that keeps the SQLite
index aligned with whatever the agent just wrote. Wire it up as a Claude
Code `PostToolUse` hook so every `Write`/`Edit` under `.code-mode/`
triggers an incremental reindex + typecheck.

1. Open `~/.claude/settings.json` (or a project-scoped
   `.claude/settings.json`).
2. Merge the `hooks` block from [`hooks/post-edit.json`](./hooks/post-edit.json)
   into your settings — if you already have a `PostToolUse` entry, append
   the matcher instead of replacing it.
3. Make sure `code-mode` is resolvable (globally installed or via
   `bunx`/`npx`).

Then run `code-mode doctor` inside any initialized workspace.

### Plugin hooks (tool-bias)

The Claude Code plugin at `plugins/code-mode` ships with hooks that steer
the agent toward `search` / `run` / `save` instead of ad-hoc native tool
calls:

- **`SessionStart`** — injects a static routing block at session start
  listing the 7 stdlib helpers and when to prefer `search` / `run` /
  `save` over writing throwaway TypeScript, calling `WebFetch`, etc.
- **`PreToolUse`** — single dispatcher (`hooks/pretooluse.mjs`) matched
  against `WebFetch`, `Bash`, and `mcp__.*`:
  - `WebFetch` → `allow` + hint pointing at the stdlib `fetch` helper.
  - `Bash` → inspects `tool_input.command`; inline-exec patterns
    (`node -e`, `bun -e`, `python -c`, `deno eval`, heredocs into
    `node`/`python`) get `ask` + a message recommending `save`.
    Ordinary `Bash` gets `allow` + a generic hint.
  - `mcp__*` (non-code-mode) → dispatched by the workspace config's
    `mcpBlockMode` (see below). `mcp__plugin_code-mode_*` is always
    silently allowed.

Hooks are **deduped per session** (state in `$TMPDIR/code-mode-hooks-<session_id>.json`) so
you only see a hint the first time a given tool fires.

#### Escape hatches

| Variable | Effect |
|---|---|
| `CODE_MODE_SKIP=1` | Bypass every hook unconditionally for the current process. |
| `CODE_MODE_MCP_BLOCK=1` | Force `mcpBlockMode: "block"` (deny non-whitelisted MCPs). |
| `CODE_MODE_MCP_BLOCK=0` | Force `mcpBlockMode: "hint"` (warn but allow). |
| `CODE_MODE_DEV_PATH=/abs/path/to/dist/cli.js` | Route the plugin through a local dev build — see [CONTRIBUTING.md](./CONTRIBUTING.md). |

#### `code-mode config`

Each workspace gets a `.code-mode/config.json` at init time. Manage it
with the `config` subcommand tree:

```bash
code-mode config get mcpBlockMode              # prints "hint" or "block"
code-mode config set mcpBlockMode block        # deny non-whitelisted MCPs
code-mode config whitelist list                # show allowed MCP prefixes
code-mode config whitelist add mcp__github__   # allow github MCP
code-mode config whitelist remove mcp__github__
```

The default whitelist allows `mcp__context7__` (docs lookup) and
`mcp__plugin_context-mode_` (sandbox runner). `mcp__plugin_code-mode_*`
is implicit and never needs to be listed.

### Stdlib helpers

`code-mode init` seeds seven reusable helpers under
`.code-mode/sdks/stdlib/`:

| Helper | What it does |
|---|---|
| `fetch` | Typed wrapper around global `fetch` with 30s timeout, retries, JSON parsing. |
| `grep` | ripgrep-backed content search returning `{ file, line, text }` rows. |
| `glob` | Node's `fs.glob` (Node 22+) with Bun-compatible fallback. |
| `fuzzy-match` | Fuzzy string ranking. |
| `table` | Pretty-print row arrays. |
| `filter` | Predicate-based row filtering. |
| `flatten` | Nested object flattening. |

The three new helpers in 0.3.0 — `fetch`, `grep`, `glob` — replace the
most common ad-hoc inline scripts the agent otherwise writes as
throwaway `node -e` one-liners.

## Repository layout

This is a Bun workspace monorepo.

```
.
├── packages/
│   ├── core/                  # published as `code-mode` on npm — CLI + MCP server
│   │   ├── bin/code-mode.ts   # CLI entry (shebang)
│   │   ├── src/
│   │   │   ├── cli.ts         # commander program
│   │   │   ├── commands/      # one file per subcommand
│   │   │   ├── analysis/      # ts-morph powered script analysis
│   │   │   ├── db/            # SQLite schema + migrations
│   │   │   ├── index/         # reindex pipeline
│   │   │   ├── mcp/           # MCP server adapter
│   │   │   ├── queries/       # FTS5 / metadata queries
│   │   │   ├── runner/        # sandboxed `run` command
│   │   │   ├── sdk-gen/       # MCP → typed SDK emitter
│   │   │   └── templates/     # workspace scaffolding
│   │   └── test/              # bun:test suite
│   │
│   └── inspector/             # browser inspector (currently dev-only, not published)
│
├── hooks/                     # Claude Code hook snippets (post-edit reindex)
├── docs/                      # user-facing docs (scripts.md, etc.)
├── thoughts/                  # design notes, research, plans (not shipped)
├── package.json               # workspace root — `workspaces: ["packages/*"]`
├── bun.lock
├── LICENSE                    # MIT
└── README.md                  # you are here
```

## Local development

```bash
bun install
bun run dev            # runs packages/core CLI from source
bun run typecheck      # tsc across all workspaces
bun run test           # bun:test across all workspaces
bun run inspect        # launch the inspector against a local workspace
```

The CLI entry point is `packages/core/bin/code-mode.ts`; it uses a bun
shebang so you can execute it directly during dev.

## Publishing

`packages/core` is what ships to npm as `code-mode`. The package is
bundled for Node via `bun build --target=node` on `prepublishOnly`.

```bash
cd packages/core
bun run build          # emits dist/cli.js + dist/migrations/
npm pack --dry-run     # inspect tarball contents
npm publish            # scoped @desplega/code-mode, publishConfig.access = public
```

The `inspector` package is not currently published; the `code-mode
inspect` command falls back to `bunx code-mode-inspect` if it can't find a
sibling install.

## License

MIT © desplega.ai — see [LICENSE](./LICENSE).
