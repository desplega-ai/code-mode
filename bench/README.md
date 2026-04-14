# @code-mode/bench

Benchmark harness for code-mode. Runs the same task prompts in isolated Docker containers across three variants and reports time, tool calls, and token usage.

## Variants

- `baseline` — plain Claude Code, no MCPs.
- `code-mode-generic` — code-mode MCP registered + a shared generic seed library from `seeds/generic/`.
- `code-mode-tailored` — code-mode MCP registered + task-specific seeds from `tasks/<id>/seeds/`.

## Quickstart

```sh
cp .env.example .env && $EDITOR .env        # set CLAUDE_CODE_OAUTH_TOKEN
docker build -t code-mode-bench:latest docker
bun install
bun run bench --reps 1 --concurrency 1      # smoke: every task x variant x 1
bun run bench --reps 3 --concurrency 2      # full sweep
```

Reports land in `results/<run-id>/report.md` and `report.json`.

## Layout

- `src/` — runner (TS, bun).
- `docker/` — Dockerfile + entrypoint.
- `seeds/generic/` — shared seed library (variant 2).
- `tasks/<id>/` — task.yaml + fixtures/ + seeds/ (variant 3).

## CLI

```
bun run bench \
  --tasks tasks/                   # or a single task dir
  --variants baseline,code-mode-generic,code-mode-tailored
  --models sonnet,opus             # aliases, or full IDs like claude-sonnet-4-6
  --reps 3
  --concurrency 2
  --out results/<timestamp>
```

`--models` accepts a CSV of model IDs or shorthand aliases (`sonnet` →
`claude-sonnet-4-6`, `opus` → `claude-opus-4-6`). The matrix fans out by
`task × variant × model × rep`, and the report shows one row per
(model, variant). Default is a single model (`claude-sonnet-4-6`). The
convenience flag `--model <id>` is equivalent to `--models <id>`.

Example comparing Sonnet vs Opus across 3 reps:

```sh
bun run bench --models sonnet,opus --reps 3
```
