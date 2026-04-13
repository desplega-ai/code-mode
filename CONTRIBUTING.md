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

## Repo layout

See the root [README.md](./README.md#repository-layout) for the full tree.
Short version:

- `packages/core/` — the CLI + MCP server, published as `code-mode`
- `packages/inspector/` — browser inspector (dev-only, not published)
- `hooks/` — Claude Code hook snippets
- `docs/` — user-facing docs
- `thoughts/` — design notes, plans, research (not shipped)
