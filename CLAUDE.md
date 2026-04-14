# code-mode — project Claude instructions

## Bench-run logging

Every time we run the bench harness (`bench/`) and produce numbers worth keeping (positive signal, negative signal, or methodology change), write a one-page summary to `bench-log/YYYY-MM-DD-<slug>.md` **in addition to** the `bench/results/<run-id>/` raw output.

The log entry is a runs *index*, not analysis. Format and scope are documented in `bench-log/README.md`. Keep it short:
- **What ran** — the actual `bun run bench …` command.
- **Where the raw is** — relative path under `bench/results/`. Force-add `report.md` + `report.json` for the run when the result is publishable; raw stream-json stays gitignored.
- **Headline numbers** — small markdown table of cost/tokens/tool-calls per variant with a delta column.
- **What it tells us** — 1–3 bullets, bottom line only. Link to the relevant `thoughts/taras/research/*.md` instead of restating analysis.
- **Cost** — total $ spent on the sweep.

If a run is purely a smoke / re-run / wiring fix and produces no new claim, **don't** create a log entry. The log is for runs whose results we'd want to find again later.

When a single calendar day produces multiple distinct runs, give each its own file (`-opus-multimcp.md`, `-bench-b-n3.md`) — don't append to one giant daily file.
