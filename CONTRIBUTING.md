# Contributing to code-mode

Thanks for helping out. This doc is a cheat-sheet for local development — how
to edit, build, and try the CLI before (or instead of) publishing.

## Setup

```bash
bun install
```

The monorepo uses Bun workspaces. `packages/core` is the published package
(`code-mode` on npm); `packages/inspector` is the browser inspector.

## Running locally

Pick the workflow that matches what you're doing.

### From source, no build (fastest iteration)

Best for editing code in `packages/core/src/**` and seeing changes
immediately. No build step, no symlinking — Bun runs the TypeScript
directly.

```bash
bun run packages/core/bin/code-mode.ts --help
bun run packages/core/bin/code-mode.ts init /tmp/playground --no-install
bun run packages/core/bin/code-mode.ts reindex --path /tmp/playground
```

Or from the package directory:

```bash
cd packages/core
bun run dev                              # alias for `bun run bin/code-mode.ts`
```

Caveats:
- Uses `bun:sqlite` (the bun-side of the runtime dispatch), so you won't
  exercise the `better-sqlite3` path this way. For that, use Option B or A.
- Needs Bun on `PATH`.

### `npm link` (dev against dist, cross-runtime)

Best when you want to test the *built* CLI (same code path users get), but
still iterate quickly on source changes.

```bash
cd packages/core
bun run build                             # emits dist/cli.js + dist/migrations/
npm link                                  # symlinks `code-mode` into global bin

# now `code-mode` is on your PATH — both node and bun runtime paths hit it
code-mode --help
code-mode init /tmp/playground --no-install

# after edits:
bun run build                             # re-bundle; the symlink keeps working
code-mode --help                          # picks up the new dist

# cleanup
npm unlink -g code-mode
```

This is the recommended workflow for touching the SQLite driver, because
`npm link` resolves `better-sqlite3` from `node_modules/` just like a real
install, so you're testing the exact node runtime path.

### Install the actual tarball (closest to what users get)

Use this right before publishing to sanity-check the packaged artifact.

```bash
cd packages/core
bun run build
npm pack                                  # produces code-mode-0.1.0.tgz

# global install from tarball (test as if already on npm)
npm install -g ./code-mode-0.1.0.tgz
code-mode --help
npm uninstall -g code-mode

# or: no global install, one-shot invocation
npx ./packages/core/code-mode-0.1.0.tgz --help

# or via bun:
bun x ./packages/core/code-mode-0.1.0.tgz --help
```

If something works via `npm link` but breaks from the tarball, the
difference is almost always in `files`, `bin`, or a missing external in
the build script — inspect `npm pack --dry-run` to see the tarball
manifest.

## Typecheck + test

```bash
cd packages/core
bun run typecheck                         # tsc --noEmit
bun test                                  # unit tests under bun:test
```

Tests run under Bun (bun's native test runner), which means the Bun side of
the runtime dispatch (`bun:sqlite` with `strict: true`) is what gets
exercised. For the Node side, use one of the install flows above and
smoke-test by hand.

## Before you publish

`prepublishOnly` in `packages/core/package.json` already runs
`typecheck && test && build`, so a plain `npm publish` is safe. Still worth
packing + installing the tarball manually first:

```bash
cd packages/core
bun run build
npm pack --dry-run                        # verify files + size
npm pack
npm install -g ./code-mode-*.tgz
mkdir -p /tmp/cm-verify && cd /tmp/cm-verify
code-mode init --no-install
code-mode save hello --source -<<'TS'
export async function main(args: { name: string }) {
  return { greeting: `hello, ${args.name}` };
}
TS
code-mode reindex
code-mode list-sdks
code-mode doctor --json
npm uninstall -g code-mode
```

## Plugin dev loop (`plugins/code-mode/start.mjs`)

The Claude Code plugin routes its MCP server and reindex hook through
`plugins/code-mode/start.mjs`, a smart-resolver that picks the fastest
available `@desplega/code-mode` entrypoint. Resolution priority (first
hit wins):

1. `CODE_MODE_DEV_PATH` env — absolute path to a `dist/cli.js`. If set
   but the file is missing the resolver errors out instead of silently
   falling through, so you always know when your dev pointer is stale.
2. `<cwd>/node_modules/@desplega/code-mode/dist/cli.js` — project-local.
3. `require.resolve("@desplega/code-mode/package.json")` from `${HOME}`
   → global install (`npm i -g`, `bun add -g`, volta, fnm shims).
4. `npx -y @desplega/code-mode` — cold-machine fallback.

### Installing the plugin locally

Four helper scripts wrap the `claude plugin` CLI for the common dev
flows. All are defined in the root `package.json` and delegate to
`scripts/plugin.sh`:

```bash
bun run plugin:install          # register this working tree as a
                                # local marketplace + install from it
bun run plugin:update           # rebuild core, refresh the marketplace,
                                # pull the latest plugin manifest
bun run plugin:uninstall        # remove the plugin + the marketplace
bun run plugin:install-remote   # swap local for GitHub
                                # (desplega-ai/code-mode)
```

`plugin:install` is idempotent — it removes any existing `code-mode`
plugin + marketplace first, so it's safe to re-run after you've been
on the remote marketplace or a different branch. After install you
still need to run `/plugin reload` (or exit + relaunch Claude Code)
for the new session's hook registrations to pick up the manifest.

Rebuild-then-reload loop after source edits:

```bash
bun run plugin:update           # rebuilds packages/core + refreshes
# then in Claude Code:
/plugin reload
```

When you're done testing locally, swap back to the published version:

```bash
bun run plugin:install-remote
```

### Iterating on the plugin

`bun run plugin:install` is the most realistic dev loop (it's what a
user actually gets on install). For the fastest inner loop —
iterating on `packages/core/src/**` without rebuilding the marketplace
on every change — use `CODE_MODE_DEV_PATH` instead, which bypasses
the marketplace entirely:

```bash
bun run --cwd packages/core build
export CODE_MODE_DEV_PATH="$PWD/packages/core/dist/cli.js"
```

Then in a Claude Code session, run `/plugin reload` — the plugin will
route every MCP + hook call through your local build. You'll see a
one-line stderr banner `[code-mode] dev path: …` on each spawn,
confirming dev mode is live.

To smoke-test without reloading the plugin:

```bash
CODE_MODE_DEV_PATH="$PWD/packages/core/dist/cli.js" \
  node plugins/code-mode/start.mjs --version
```

Unset `CODE_MODE_DEV_PATH` when you're done so the plugin goes back to
whichever install is on disk.

### Iterating on hooks (`SessionStart`, `PreToolUse`)

The plugin ships two hook scripts under `plugins/code-mode/hooks/`:

- `sessionstart.mjs` — emits a static routing block.
- `pretooluse.mjs` — dispatcher for `WebFetch` / `Bash` / `mcp__.*`.

Both are plain Node scripts that read JSON from stdin and emit JSON on
stdout, so you can iterate on them without reloading the plugin:

```bash
# SessionStart — no stdin needed
node plugins/code-mode/hooks/sessionstart.mjs < /dev/null | jq .

# PreToolUse — craft a tool call payload and pipe it in
echo '{"tool_name":"Bash","tool_input":{"command":"node -e 1"}}' \
  | node plugins/code-mode/hooks/pretooluse.mjs | jq .
echo '{"tool_name":"WebFetch","tool_input":{"url":"https://example.com"}}' \
  | node plugins/code-mode/hooks/pretooluse.mjs | jq .
echo '{"tool_name":"mcp__github__list_issues","tool_input":{}}' \
  | node plugins/code-mode/hooks/pretooluse.mjs | jq .
```

The dedup state is keyed by `session_id`, so pass distinct IDs between
runs if you want to see the first-hit behaviour:

```bash
echo '{"tool_name":"WebFetch","session_id":"dev-'"$(date +%s)"'","tool_input":{}}' \
  | node plugins/code-mode/hooks/pretooluse.mjs | jq .
```

`CODE_MODE_SKIP=1` short-circuits both scripts to an empty object — use
it when you're debugging an unrelated bug and want hooks out of the way.

### Claude Code plugin matchers

The plugin's `plugin.json` uses regex-style matchers (confirmed working):

- `Write|Edit|MultiEdit` — the existing `PostToolUse` reindex matcher.
- `mcp__.*` — the new `PreToolUse` matcher that catches every MCP tool
  and lets the dispatcher filter inside the hook script.

If you add a new matcher, the hook script still gets the raw
`tool_name` in stdin — dispatch there rather than duplicating matcher
logic in `plugin.json`.

## Repo layout

See the root [README.md](./README.md#repository-layout) for the full tree.
Short version:

- `packages/core/` — the CLI + MCP server, published as `code-mode`
- `packages/inspector/` — browser inspector (dev-only, not published)
- `hooks/` — Claude Code hook snippets
- `docs/` — user-facing docs
- `thoughts/` — design notes, plans, research (not shipped)
