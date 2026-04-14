---
title: "External agent/LLM benchmarks survey — what to adapt for code-mode"
author: claude (for taras)
date: 2026-04-14
status: research
related:
  - thoughts/taras/research/2026-04-14-multi-mcp-findings.md
  - thoughts/taras/research/2026-04-14-code-mode-value-prop-reframing.md
---

# External bench survey — what we should adopt to test code-mode's real thesis

Our in-house harness is single-turn and proves only the cost floor. code-mode's claimed regime is **long-horizon, multi-turn, multi-MCP, and cross-session**. Below are the benches that could credibly stress those axes.

## 1. TL;DR table

| Bench | What it measures | Relevant? | Adapter cost |
|---|---|---|---|
| **MCP-Universe** (Salesforce AIR) | LLM/agent success over 6 domains × 11 real MCP servers, long-horizon multi-turn, scattered evidence | **Yes — best fit** | **Low–Med** |
| **MCP-Bench** (Accenture) | Tool-using agent over 28 live MCP servers / 250 tools, single- and multi-server tasks, LLM-judge | **Yes** | **Low** |
| **τ²-bench / τ³-bench** (Sierra) | Multi-turn agent↔user↔tools dialogue under domain policy (airline, retail, telecom, banking); `pass^k` consistency across 4 trials | **Partial — multi-turn only, not multi-session** | Medium |
| **TheAgentCompany** (CMU) | 175 multi-step software-company tasks in a self-hosted GitLab+OwnCloud+RocketChat env; long-horizon, browser+code+comms | **Yes — best "agent-swarm shape"** | **High** (heavy docker stack) |
| **SWE-bench Verified / Live** | Resolve real GitHub issues with a patch; agent writes/runs code against a real repo | Partial — code agent regime but single-issue, not multi-session | Medium |
| **LoCoMo / LongMemEval** | QA over very long (≈27-session, 588-turn) synthetic conversations; directly probes memory retrieval after compaction | **Yes — on "knowledge survives compaction"** | **Low** (dataset-only) |
| **OSWorld-Verified** | 361 real desktop-app GUI tasks, screenshots + a11y tree, execution-graded | No — GUI/VLM regime, not tool-use | High |
| **GAIA** | 450 general-assistant questions needing web + tools + reasoning, Level 1–3 | Partial — tool use, but short chains | Low |
| **BFCL** (Gorilla) | Function-call correctness, single/multi/parallel/multi-step; auto-graded | No — measures call syntax, not persistence | Low |
| **LiveCodeBench v6** | 1,055 competitive-programming problems, contamination-controlled | **No** — pure code-gen; skip |

(10 rows, not 5–8, because the brief asked to at-minimum-cover those. The top 4 is where we should actually spend effort.)

## 2. Per-bench detail

**MCP-Universe** (Salesforce AI, ICLR'26, Apache-2.0). Real MCP servers: Google Maps, GitHub, Notion, Airbnb, Playwright, Blender, Yahoo Finance, etc., across Location Navigation / Repo Mgmt / Financial / 3D Design / Browser / Web Search. Explicitly designed for *long-horizon multi-turn tool calls, long context windows, scattered evidence, large tool spaces*. GPT-5-High tops out at 44% success; plenty of headroom. Python 3.10 + Docker + API keys. Ships a framework (`mcpuniverse`) with pluggable agents — you register an agent class, it drives the eval. No Claude Code / `claude -p` harness out of the box, but the agent abstraction is clean enough to wire one. Source: https://github.com/SalesforceAIResearch/MCP-Universe, https://mcp-universe.github.io/.

**MCP-Bench** (Accenture, Apache-2.0). 28 MCP servers, 250 tools, finance/travel/science/academic. Tasks split into single-server / 2-server / 3-server JSON files. LLM-as-judge (o4-mini hard-coded in `benchmark/runner.py`). HuggingFace leaderboard. Lighter weight than MCP-Universe and directly mirrors our own `multi-mcp-upsert` shape — perfect for scaling the signal we already found (N=3 → 28 servers). Source: https://github.com/Accenture/mcp-bench.

**τ²/τ³-bench** (Sierra, MIT). Agent + LLM-simulated user + tool APIs + policy doc (retail, airline, telecom, banking). τ³ adds voice modality. Reports `pass^1…pass^4` — the same task run 4× independently; drop-off measures *policy-consistency* and is as close as any public bench gets to "does your agent stay coherent across trials." Not multi-session: each trial is independent with no persistence between them. Good for our "consistency across turns" axis, bad for our "knowledge survives restart" axis. Source: https://github.com/sierra-research/tau2-bench.

**TheAgentCompany** (CMU/IBM, OpenReview'25, MIT). 175 tasks, self-hosted miniature company: GitLab, OwnCloud, RocketChat, Plane. Tasks span coding, data analysis, HR, PM comms with simulated coworkers. Multi-step, long-horizon. Best agent currently hits 30%. This is the most realistic "agent-swarm shape" in public — exactly the kind of environment where a persistent `.code-mode/` could compound across tasks. Cost: heavy docker stack, hours to stand up. Source: https://the-agent-company.com/, https://github.com/TheAgentCompany/TheAgentCompany.

**SWE-bench Verified / Live** (MIT). Verified=500 human-filtered Python issues. Live adds 50 new issues/month from 223 repos since 2024 (contamination control). Each instance has its own Docker image. Canonical industry bench — Anthropic, OpenAI, DeepMind all report against Verified. Relevant as *external credibility* only: each instance is one-shot (fix this issue), so it doesn't naturally test cross-session persistence. Could be adapted into a "warm-repo" variant where the agent has already seen the repo once. Source: https://swebench.com, https://github.com/microsoft/SWE-bench-Live.

**LoCoMo / LongMemEval** (Snap Research / MIT). Long-term conversational memory: 10 conversations × ~27 sessions × ~588 turns each; 5 reasoning types including multi-hop and temporal. Dataset-only — you bring the agent. Maps *directly* onto Bench B (cross-session persistence) in the value-prop reframe. Pure input-output, no tool use, so it wouldn't exercise `__save`/`__run` — but it would prove or disprove the "retrieval beats re-derivation" half of the thesis. Source: https://github.com/snap-research/locomo.

**OSWorld-Verified** (xlang-ai, Apache-2.0). 361 real desktop tasks across Chrome, VSCode, LibreOffice, GIMP, etc. VM-based. VLM/GUI regime. Not code-mode's territory — skip unless we pivot to computer-use agents.

**GAIA** (Meta, CC-BY-4.0). 450 multi-step general-assistant questions, Levels 1–3. Agents need web, files, code. Good for general tool-use competence but chains are short (<10 steps median). Humans 92% vs frontier models ≈50–60%. Relevant as a sanity check, not as code-mode's primary arena.

**BFCL** (Berkeley, Gorilla). Function-call syntax correctness — AST-compared or executed. Not a tool-use *behaviour* bench; a tool-call *syntax* bench. Skip; it measures a regime code-mode doesn't touch.

**LiveCodeBench v6** (2026-04, 1,055 problems). Pure competitive-programming code-gen. Irrelevant to code-mode's thesis. Mentioned only because the brief asked.

### Proprietary / industry context (mention, can't run)

- **SWE-bench Verified** — de facto industry scoreboard (Anthropic, OpenAI, Cognition).
- **CodeClash** (11/2025, swebench.com) — LMs as *goal-oriented developers* vs task-oriented. Emerging.
- **Devin-internal eval**, **Vercel v0-bench**, **Cursor internal harness** — not public.
- **Anthropic SDK evals** (agent-sdk-dev skill mentions): internal.
- **HAL Leaderboard** (Princeton) — aggregates GAIA, SWE-bench, others with a harness we could hook into.

## 3. Recommendations (ranked)

1. **MCP-Bench** — lowest adapter cost; already looks like our `multi-mcp-upsert` task at 10× the breadth. Scales our existing positive Sonnet signal across 28 servers × 250 tools. If the −19–30% cost win holds, we have a defensible public result against an Accenture-labelled Apache-2.0 bench. **Start here.**

2. **MCP-Universe** — the most credible external MCP bench (Salesforce AI, arXiv 2508.14704). Explicitly targets long-horizon and large-tool-space, which is exactly code-mode's pitch. Adapter is slightly heavier than MCP-Bench (more API keys, some domains need cloud services), but a positive result here is citable externally. **Second priority.**

3. **LoCoMo** (or LongMemEval) — the only public bench that directly tests "does memory survive session breaks." No tool-use, so it doesn't stress `__save`/`__run`, but it would let us test a code-mode-flavoured memory adapter (store conversation summaries as typed scripts, retrieve via `__search`) against vector-DB baselines. Dataset is small; wiring is cheap. **Third — complements our Bench B.**

4. **τ²/τ³-bench** — multi-turn and policy-constrained, with `pass^k` as a built-in consistency metric. Good credibility (Sierra, used in papers and industry). But single-session; the persistence axis is absent. **Fourth — only if we want a multi-turn-but-not-multi-session slice.**

**Skip for now**: TheAgentCompany (high setup cost; revisit once agent-swarm integration exists), SWE-bench (narrow code-gen regime), OSWorld (wrong modality), BFCL/LiveCodeBench (wrong regime entirely).

## 4. What's missing from every public bench

No public bench measures **cross-session workspace persistence for a tool-using agent** — i.e. "agent A works on task X in session 1, restarts container, session 2 should benefit." LoCoMo covers the conversation-memory half, MCP-Universe covers the tool-use half, but nothing combines them. **This is the axis where code-mode's claim is most distinctive, and where we'll have to keep running our own Bench B.** That's a strength when pitching, not a weakness — "no one benchmarks this yet" is a credible framing for a research-y blog post.

Also missing: **multi-agent shared-workspace** (Bench C). Swarm-style evaluation doesn't exist publicly; we'd have to build it.

## 5. Adapter sketch — MCP-Bench (the top pick)

- Fork `Accenture/mcp-bench`. Its runner is Python; we keep it as-is.
- Add a new model entry in `llm/factory.py` that points to **Claude Code** (`claude -p`) instead of OpenAI/Anthropic SDK direct. The agent becomes "a subprocess running `claude -p` with MCPs configured via `.mcp.json`."
- Register **two variants** side-by-side: `claude-baseline` (Claude Code + the 28 MCP servers, no plugin) and `claude-codemode` (same + `@desplega/code-mode` MCP + plugin hook).
- Preserve the bench's LLM-judge (o4-mini hard-coded) — don't swap it; that's what keeps results comparable to the leaderboard.
- Extend the runner to dump our existing telemetry (wall time, tokens, tool-call counts, `ToolSearch` count) into a sidecar JSON alongside MCP-Bench's own metrics.
- Start with single-server tasks (`mcpbench_tasks_single_runner_format.json`) to establish baseline parity, then 2-server, then 3-server — expecting the code-mode delta to *grow* with tool-surface bloat per the hypothesis in `multi-mcp-findings.md`.
- Cost guard: set a per-run cost cap via Claude Code's `--max-turns` and a per-sweep budget check; MCP-Bench tasks are open-ended and a bad run on 3-server configs could burn a lot of Sonnet tokens.
- Blocker risk: `python run_benchmark.py` assumes one model interface; wrapping `claude -p` inside that abstraction needs ~50–150 LOC of glue (spawn subprocess, stream JSON, collect final assistant message as the "answer" the judge grades).
- Estimate: **2–3 days to working adapter + one N=3 sweep on single-server tasks**; another 2 days to extend through 2- and 3-server. The existing Docker-entrypoint pattern from our `bench/docker/` should port cleanly.

**Single-sentence recommendation: fork MCP-Bench next and wire `claude -p` into its runner as two variants (baseline vs code-mode-plugin) — it's the cheapest credible external bench that tests exactly the regime where our own data has already shown a signal.**
