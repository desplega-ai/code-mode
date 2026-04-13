# code-mode

CLI + MCP server for typed, reusable script management. See the [implementation plan](./thoughts/taras/plans/2026-04-13-code-mode.md).

## Integrate with Claude Code

code-mode's `reindex --paths <file>` flag is the cheap seam that keeps the
SQLite index aligned with whatever the agent just wrote. Wire it up as a
Claude Code `PostToolUse` hook so every `Write`/`Edit` under `.code-mode/`
triggers an incremental reindex + typecheck. Broken scripts flip to
`status = 'unusable'` immediately and fall out of `search` results, so the
agent doesn't re-discover its own dead code.

A ready-to-paste snippet lives in [`hooks/post-edit.json`](./hooks/post-edit.json).

### Install

1. Open `~/.claude/settings.json` (or a project-scoped `.claude/settings.json`).
2. Merge the `hooks` object from `hooks/post-edit.json` into your settings —
   if you already have a `PostToolUse` entry, append the matcher instead of
   replacing it.
3. Make sure `bunx` is on `PATH` and `code-mode` is installed (either
   globally or resolvable via `bunx -p code-mode`).

Then run `code-mode doctor` inside any initialized workspace — it full-
typechecks every indexed script and marks any that fail as `unusable`. Pass
`--json` for machine-readable output, `--stale-days 14` to tune freshness,
and `--no-fail` to force exit 0 in CI.

## Cleanup

`code-mode gc` (default dry-run) surfaces duplicate symbols and stale
scripts. Pass `--apply` to move stale scripts into
`.code-mode/.trash/<timestamp>/` — nothing is ever deleted, just relocated,
so rolling a decision back is a single `mv`.
