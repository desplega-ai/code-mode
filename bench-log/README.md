# bench-log

Chronological journal of bench runs. One file per run-day per topic, named
`YYYY-MM-DD-<slug>.md`. Cheap to skim, cheap to grep, easy to link to from
research docs.

Each entry should capture:
- **What ran**: variants × tasks × models × reps, and the runner command used.
- **Where the raw is**: path under `bench/results/<run-id>/` (raw files are
  gitignored by default; force-add `report.md` + `report.json` when
  the run is publishable).
- **Headline numbers**: cost / tokens / tool calls per variant, plus the
  delta vs the relevant baseline. One small markdown table.
- **What it tells us**: 1–3 bullets — what the data confirms, contradicts,
  or leaves open. Not analysis; just the bottom line.
- **Cost**: dollars spent on this sweep (from `total_cost_usd` aggregated).

Don't restate methodology — link to the relevant `thoughts/taras/research/`
doc instead. This log is a runs *index*, not a writeup.
