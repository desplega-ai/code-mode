---
title: "code-mode — value-prop reframing after a sad benchmark"
author: claude (for taras)
date: 2026-04-14
status: research
related:
  - bench/results/favor-n3/report.md
  - bench/results/nudged/report.md
  - thoughts/taras/brainstorms/2026-04-12-code-mode.md
  - thoughts/taras/plans/2026-04-13-plugin-tool-bias-hooks.md
---

# code-mode — value-prop reframing after a sad benchmark

## TL;DR

The N=3 bench (`bench/results/favor-n3/report.md`) showed code-mode tailored
variants +91% / +98% slower on two of three tasks and essentially flat on
the third, with **zero autonomous `mcp__code-mode__*` calls in 27/27 runs**.
A nudged run forcing the tool was 2.9× slower and 2.2× more tokens. That is
a real, reportable result — but it measures the *wrong system*. It measures
single-turn `claude -p` against cold containers, which is the one shape where
every code-mode cost is paid and none of its compounding benefits accrue.

Your thesis ("context, accuracy, speed over the long run, for general agents
like agent-swarm / openclaw") is still defensible, but the current artifact
can't support it. This doc spells out what the benchmark can and cannot see,
where the real value lives mechanically, how agent frameworks actually
consume code-mode, four concrete bench shapes that would test the thesis,
and an honest verdict.

---

## 1. What the benchmark actually measures

Bench harness: `bench/README.md`, `bench/src/` and `bench/tasks/`. Shape:

- **Transport:** single-turn `claude -p "<prompt>" --output-format stream-json`
  per task per variant per rep, inside a fresh Docker container.
- **Variants:** `baseline` (no MCPs), `code-mode-generic` (stdlib + shared
  seeds under `bench/seeds/generic/`), `code-mode-tailored` (task-specific
  seeds under `tasks/<id>/seeds/`).
- **Metrics:** wall time, total tokens, tool-call count, per report.md.
- **Tasks (3 used for favor-n3):** `log-grep-errors`, `orders-dedupe`,
  `todos-completion`. Each is a small, well-scoped data-munging job that a
  single Bash/Grep/Glob invocation dispatches in one shot.

What this design **can** see:
- Whether the model, in one shot, picks `mcp__code-mode__search` over `Bash`.
- Cold-start overhead of registering the MCP server (~5s startup, +~2%
  tokens).
- End-to-end latency of `__search → __save → __run` on a cold workspace.

What this design **cannot** see:
- **Knowledge reuse across turns** — a fresh container has no prior scripts
  except the planted seeds, and the agent never gets a turn 2.
- **Compaction survival** — code-mode's whole reason to exist is "the shape
  of API X gets encoded in a file on disk and survives `/compact`." One
  turn never compacts.
- **Context-window pressure** — 150k–185k tokens of the 200k budget, with
  no multi-API orchestration forcing the model to hold more than one thing
  in memory, is nowhere near the regime where a filter-in-subprocess step
  dominates.
- **Typed composition** — the sad tasks are literally one grep or one dedup.
  The benchmark is asking "does code-mode beat `grep` at `grep`" and the
  answer is, correctly, "no."
- **Multi-agent sharing** — each run is one agent. There's no case where
  agent A saves `filter-errors.ts` and agent B finds it tomorrow.
- **Accuracy gains from the typecheck gate** — `execScript`
  (`packages/core/src/runner/exec.ts:1-90`) refuses to run code with type
  errors, so an agent that writes broken TS gets a structured diagnostic
  instead of a runtime crash. The bench tasks never exercise this because
  baseline `Bash` just works.

The 2% token overhead is real and almost entirely the tool-manifest bloat
from registering five MCP tools + the generated SDK listings. That's a
one-time cost amortised over a session — per-turn in a long session, not
per-invocation of `claude -p`.

**Bottom line:** the bench is a cold-start, single-shot, one-API test. It
measures the cost floor of adding code-mode. It does not sample from any
regime where code-mode could compound.

---

## 2. Where code-mode's value actually lives

Three axes, grounded in the implementation.

### 2a. Long-term context (the main claim)

code-mode treats scripts as **externalised memory with executable semantics**.
Concrete mechanisms:

1. **SQLite + FTS5 index** (`packages/core/src/queries/search.ts`,
   `src/mcp/handlers/search.ts`). `search` returns pointers — *path, name,
   description, scope, kind, score* — not source. A saved script at turn 3
   shows up as a ~30-token pointer at turn 40. The alternative (the model
   re-derives the approach) is hundreds of reasoning tokens plus potentially
   re-fetching the API shape.
2. **PostToolUse reindex hook** (README "Claude Code integration"). Every
   `Write`/`Edit` under `.code-mode/` re-typechecks and reindexes
   incrementally. Broken scripts flip to `status = 'unusable'` and fall out
   of search. The agent doesn't rediscover its own dead code. This is
   invisible in single-turn but is load-bearing at turn 50.
3. **Script contract** (`docs/scripts.md`): `export default async function
   main(args): Promise<unknown>`. A script is a self-contained typed
   function. It encodes the shape of the API it wraps — so the model, seeing
   a `fetch-user-prs.ts` signature, knows the return type without
   re-deriving it from raw API docs. That's real context savings at turn N.
4. **Generated SDKs** (`.code-mode/sdks/.generated/`, brainstorm §
   "Architecture Sketch"). When an MCP server is wired up, code-mode
   generates a TS wrapper with real types. Those types are pulled into
   `search`/`query_types` — i.e. the types become *searchable*, not
   context-resident. Cloudflare's original code-mode paper's core claim,
   which Taras' brainstorm cites directly: "LLMs are better at writing code
   to call MCP than at calling MCP directly" — restated as a context claim,
   the TS surface is a smaller, more structured representation than the
   verbose MCP tool manifests.

The benchmark never exercises any of these because it never reaches turn 2.

### 2b. Accuracy

1. **Typecheck gate** (`runner/exec.ts`). `execScript` loads the entry into
   a ts-morph `Project`, collects diagnostics transitively (depth-capped
   16), and returns `{ success: false, reason: 'typecheck', diagnostics }`
   *without* spawning. The agent gets a structured compiler error, not a
   runtime stack trace. This is strictly better for self-correction loops.
2. **Cached known-good scripts.** If `orders-dedupe-v2.ts` has `runs: 47`
   and `success_rate: 0.96` in the index (brainstorm's metadata design, now
   implemented), search ranks it above a newer, untested draft. The agent
   is nudged toward the script that has empirically worked. Baseline Bash
   has no equivalent memory of "this incantation works; that one doesn't."
3. **Typed composition.** Scripts can `import` other scripts and stdlib
   helpers. This is functional-programming-for-agents — the agent doesn't
   re-implement fuzzy matching on turn 17 because `@/sdks/stdlib/fuzzy-match`
   is right there and typed.

Again, single-turn with pre-planted correct seeds never exercises any of
this — the baseline gets the answer right first try on the toy tasks.

### 2c. Speed / optimality

Here the benchmark is honest and bad: **per-shot, code-mode is slower**. The
reasons aren't mysterious:

- `handleRun` (`src/mcp/handlers/run.ts`) delegates to `execScript`, which
  loads a ts-morph Project (expensive), typechecks transitively, then
  `Bun.spawn`s a subprocess. On cold cache, that's seconds you don't pay in
  `Bash`.
- The MCP stdio roundtrip itself is ~100–300ms per call on top.

Where speed wins show up:
- **Reuse amortises the cost.** Turn 1 pays the script-writing cost. Turns
  2..N only pay an `__run` on an already-typechecked, already-indexed
  script. The crossover point depends on task repetition rate.
- **Context compression = faster model turns.** If a script trims a 5,000-row
  API response to 5 rows before it enters the context, the model's *next*
  turn is cheaper (fewer input tokens) and faster. This compounds across a
  long session and is exactly the regime `claude -p` one-shot misses.
- **Parallel subagents sharing a workspace.** agent-swarm-style leaders can
  spawn workers that all hit the same `.code-mode/`; the cost is paid once,
  the benefit is distributed.

None of that shows up at N=3 × 1 turn × 1 task.

---

## 3. How agent frameworks use code-mode differently

### agent-swarm (`/Users/taras/Documents/code/agent-swarm/`)

The README's "Agents Get Smarter Over Time" section is the literal mirror
of code-mode's thesis:

- **Persistent identity**: `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `CLAUDE.md`
  per agent, synced to DB on edit, restored on restart.
- **Startup scripts**: `/workspace/start-up.sh`, editable by the agent,
  re-run every container start — "an agent that discovers it needs ripgrep
  will install it once and it'll be there for every future session."
- **Memory tools**: `memory-search`, `memory-get`, `inject-learning`
  (MCP.md).

code-mode is *literally the same primitive for typed executable knowledge
instead of prose*. The TOOLS.md pattern — "the API runs on port 3013, use
`wts`" — is the thing code-mode makes into a runnable, typechecked script
instead of a prose note the agent has to re-parse. A swarm agent's natural
arc:

- **Turn 1–5:** agent figures out how to hit an internal API. Saves
  `fetch-internal-metrics.ts` via `__save`. Hook reindexes. Runs: 1.
- **Turn 30:** context has compacted twice. The agent asks "how do I hit
  the metrics endpoint" — `__search "metrics"` returns a pointer. One
  `__run`, done. No re-derivation.
- **Next session (days later):** same agent restarts, DB restores identity.
  `.code-mode/` is persisted on the worker volume. The script is still
  there. Runs: 47, success_rate: 0.96 — search ranks it top.
- **Another agent on the same swarm** hits the same repo and inherits the
  script library.

The benchmark does *none* of this.

There is currently **no** hard-wired code-mode integration in agent-swarm
(`grep -r code-mode` in agent-swarm src/plugin/ returns nothing relevant)
— it's an ambient dependency: a swarm agent that has `@desplega/code-mode`
globally installed gets the MCP. That's a gap: there's no `wts`-equivalent
bootstrapping of `.code-mode/` in swarm worker volumes, no system-prompt
nudge telling the agent to prefer it, no shared script volume across
workers.

### openclaw (`/Users/taras/Documents/code/openclaw/`)

No direct integration (`grep code-mode` only matches an unrelated
`kilocode-models` symbol). openclaw is a sandboxed Claude harness with its
own skill system (`skills/`, `AGENTS.md`). Same story as swarm: it's a
target for the plugin, not a consumer. The shape openclaw cares about —
long-running sandboxed agents with a persistent workspace — is exactly the
shape where code-mode compounds.

### README signals

`packages/core/README.md` and the root README both lead with "typed,
reusable script management" and "survives across sessions" — so the product
*positions* itself for the long-haul case. The bench harness just doesn't
test that positioning.

---

## 4. Benchmark designs that would measure the real value prop

**Model matrix for every bench below:** run across `claude-sonnet-4-6` and
`claude-opus-4-6` as distinct cells (not just Claude Code's default). Weaker
models are more likely to default to `Bash` because it's the "safe" path
they've seen a million times in training; Opus and Sonnet 4.6 are the
realistic targets for agentic engineering workloads and are more likely to
pick up tool affordances when they compound. Report per-model deltas
separately — conflating them hides exactly the signal we care about. Add
the model dimension to the harness via a `--model` flag that sets
`ANTHROPIC_MODEL` (or the equivalent CLI arg) inside the container.

Four concrete shapes, ordered by implementability.

### Bench A — multi-turn task with forced compaction

**Setup:** one container, one agent, 15 turns, an `/compact` forced at
turn 8. Task: analyse a rolling log stream where each turn asks a new
question about the same structured data (e.g. "top 5 errors," then "errors
by hour," then "users affected," etc.).
**Variants:** baseline vs code-mode-plugin (no pre-planted scripts — the
agent builds its library as it goes).
**Metric:** turns-to-answer per question *after compaction*, plus total
tokens across the whole session.
**Hypothesis:** code-mode's win appears after compaction. Baseline
re-reads/re-greps raw data; code-mode retrieves a saved script pointer.
**Why it's credible:** directly targets "context compacts, knowledge
survives."

### Bench B — cross-session persistence

**Setup:** run session 1 (10 turns, build scripts). Destroy the container.
Start session 2 with the same `.code-mode/` volume mounted but a *fresh*
model conversation. Ask related questions.
**Variants:** baseline (nothing survives) vs code-mode (scripts + index
survive).
**Metric:** time-to-first-useful-answer in session 2; fraction of session
2 turns that call `__run` on a session-1 script.
**Hypothesis:** code-mode's session-2 start is dramatically faster because
the agent finds and reuses prior work. Baseline re-derives from scratch.

### Bench C — multi-agent shared workspace (swarm shape)

**Setup:** two or three agents in parallel against the same `.code-mode/`,
given overlapping tasks (different questions on the same API/dataset).
Use agent-swarm or just a scripted multi-process harness.
**Metric:** wall-clock and token-cost for the *fleet* to complete all
tasks. Tool-call overlap (how often agent B runs a script agent A wrote).
**Hypothesis:** cost-per-task drops roughly as 1/N because the first agent
pays for script authorship and the rest pay only for `__run`.

### Bench D — accuracy under adversarial API changes

**Setup:** 20-turn task against a mock API. At turn 10, change a field
name in the API response. Measure recovery.
**Variants:** baseline Bash (re-figures it out each time) vs code-mode
(typecheck gate flags the break; agent repairs the script once).
**Metric:** time to recover; number of incorrect-answer turns post-change.
**Hypothesis:** code-mode recovers faster because the typecheck gate in
`execScript` produces a structured diagnostic pointing at the broken
field, and the fix propagates to every future `__run`.

### Bench E (stretch) — context-window position of relevant knowledge

**Setup:** instrument a 50-turn session. At each turn, measure the
*distance from the model's attention head* (proxy: position in the
prompt) to the token that encodes the relevant domain knowledge.
**Variants:** baseline (knowledge inlined, scrolls out) vs code-mode
(knowledge in DB, pulled via pointer at request).
**Metric:** mean retrieval-distance-to-relevant-knowledge across turns.
**Hypothesis:** code-mode keeps the *summary* (pointer) in context and
the *weight* (the script) on disk, which is fundamentally more scalable
than inlining prose.

Pick A and B first — they're the most directly testable, and B is the
single most defensible experiment for "the product does what we claim."

---

## 5. Honest verdict

### Is the sad result a finding? Yes — a narrow one.

The real finding is: **in single-turn `claude -p` with current default
system prompts and no SessionStart routing, models do not autonomously
reach for `mcp__code-mode__*` tools, even when a perfectly tailored seed is
sitting right there.** That is a *product* finding, not a repudiation of
the thesis. It has two sharp implications:

1. **Tool affordance matters.** The `plugins/code-mode` SessionStart hook
   (`thoughts/taras/plans/2026-04-13-plugin-tool-bias-hooks.md`, Phase 4)
   — which injects a routing block into every session — is on the right
   track. The bench didn't test that plugin wired up; if it had, results
   might differ. Worth re-running favor-n3 with the plugin's SessionStart
   hook active as a fourth variant, *before* declaring anything.
2. **The nudged experiment (2.9× slower) is the ceiling of single-turn
   pathology.** If the model is forced to route a one-shot grep through
   `__search → __run` and the script doesn't amortise across turns, of
   course it's slower — you paid script-dispatch tax for a one-off. That's
   not a code-mode bug; it's a category error in the benchmark.

### Is the thesis still defensible? Yes, but it needs a different artifact.

### Reframe the pitch

The current README sells code-mode as "typed, reusable script management,"
which reads like a dev-tooling product and invites comparisons with `bash`
— a comparison we lose. Reframe it as infrastructure for a narrower,
sharper audience:

> **code-mode is a persistent-memory substrate for autonomous agents.**
> It converts ephemeral model work (throwaway scripts, re-derived API
> shapes, prose notes about "how I did this") into typed, indexed,
> re-executable artefacts that survive context compaction and session
> restarts. Its value is proportional to (a) session length, (b) task
> repetition rate, (c) number of agents sharing the workspace, and (d)
> frequency of forced context compaction. At all four = low, it is a net
> cost. At all four = high, it is a force multiplier.

### Reframe the measurement — LLM-as-judge

Wall time and token count are the wrong primary metrics for the real use
case. They measure *efficiency* of a single run, not the qualities Taras's
thesis actually claims: **correctness over long horizons, knowledge
retention across compaction, and compounding accuracy**. Those need a
judge, not a stopwatch.

Proposed measurement stack for Bench A–E:

- **Primary: task-pass-rate** judged by a stronger model (Opus 4.6 or a
  separate judge model) against a rubric per task. Rubric covers
  correctness, completeness, and — critically — *consistency across turns*
  (does turn 12's answer still agree with turn 3's when both pull from the
  same underlying data?).
- **Primary: knowledge-retention score.** After compaction, ask a probe
  question whose answer depended on turn-3 work. Did the agent recover
  the answer via `__search`/`__run`, re-derive from scratch, or get it
  wrong? Judge this categorically.
- **Secondary: token & wall time**, reported but not primary. They matter
  operationally but they aren't what the thesis stands on.
- **Tertiary: tool-affordance fidelity** — did the agent reach for
  code-mode when a human reviewer would have said "yes, that was the
  right tool here"? Also LLM-as-judge on a trace.

Empirical evidence we can currently cite for any of this: none that's
positive. The favor-n3 and nudged runs don't disprove the thesis; they
just don't reach its regime, and they measure the wrong axis anyway.

### Route code-mode work into sub-agents (product change, not just a bench)

The favor-n3 / nudged data suggests a deeper problem than missing
affordances: **the `__search → __save → __run` loop itself pollutes the
parent agent's context window.** When the parent agent writes a script,
inspects `__run` output, iterates on typecheck errors, and finally gets
the typed result, dozens of kilotokens of intermediate state (TS source,
stderr, partial outputs, search results) land in the transcript that will
later compact. That's the opposite of the thesis — we're *adding* context
pressure where we promised to remove it.

**Proposal: update the code-mode skill (and/or add a native Claude
sub-agent) so that every create-run-iterate loop happens in a child
context window, and only the final typed result bubbles up.**

Concretely:

- **Skill update** (`plugins/code-mode/skill.md` or equivalent): when the
  parent model decides "I should write/run a code-mode script," route the
  call through a sub-agent rather than executing inline. The skill's
  instruction tells the model to spawn a child agent with a focused
  prompt ("write and run a script that does X, return only the result"),
  and to consume only the child's final answer.
- **Native Claude sub-agent**
  (https://code.claude.com/docs/en/sub-agents): ship a first-class
  sub-agent definition (e.g. `.claude/agents/code-mode-runner.md` or
  wherever the agent SDK stores them) that specialises in the
  write/typecheck/run loop. Naming suggestions: `scripter`, `script-
  runner`, `code-mode-worker`. Probably `scripter` — short, verb-ish,
  doesn't repeat "code-mode" which is already in the MCP tool namespace.
- **Background-agent variant**: for longer scripts (e.g. multi-minute
  scrapes, batch transformations), spawn the sub-agent as a background
  task so the parent keeps working while the child iterates.

This is the piece that makes code-mode's cost model line up with its
pitch. Right now, "a saved script" costs the parent context the price of
authorship; with sub-agent routing, authorship cost stays in the child
and only the *pointer* + *final output* reaches the parent. That maps
directly onto benefit (c) in §2: context-window pressure drops because
the weight stays on disk and in sub-agent transcripts, not in the parent.

It also changes what Bench A/B/C need to measure: the benchmark should
compare (1) inline code-mode usage, (2) sub-agent-routed code-mode usage,
and (3) baseline Bash. I'd expect (2) to be the only variant that's
clearly better than (3) on long-horizon metrics.

### What the next experiment should be

**Run Bench B (cross-session persistence) before anything else.** It's the
cheapest experiment that can actually *demonstrate* the core claim, and if
it comes out flat or negative, that's a much more damning result than the
current data — it would mean the persistence mechanism itself isn't
working as advertised. If it comes out strongly positive, you have a
publishable story that reframes favor-n3 as "the pessimistic lower bound,
measured under adversarial conditions."

A secondary priority: add a **4th variant** to the existing harness called
`code-mode-plugin` (code-mode MCP + the SessionStart routing hook from
`plans/2026-04-13-plugin-tool-bias-hooks.md`), and a **5th variant** called
`code-mode-subagent` (code-mode MCP + the sub-agent routing described
above). Re-run favor-n3 on Sonnet and Opus. If the plugin moves tool-call
counts from zero to non-zero, you've validated that models *can* be
steered toward the tool without manual prompt hacking. If the sub-agent
variant shows *lower* parent-context growth per turn than even baseline,
you've validated the core architectural pitch.

### What to stop claiming

- **"code-mode makes one-shot tasks faster."** It doesn't, and favor-n3
  rigorously shows this. Own this out loud: code-mode is **not a tool for
  vibe-coders running `claude -p` on ad-hoc prompts**. On that surface it
  is a net cost — extra startup, extra tokens, zero autonomous uptake.
  Saying this plainly is the honest move and it also sharpens the
  audience: agentic engineers building long-horizon autonomous systems,
  not one-shot power users.
- **"Models reach for code-mode when it's useful."** They don't, not
  without system-prompt steering. Fix the affordance (the plugin hook)
  before re-benchmarking.

### What to start claiming (cautiously, pending Bench B)

- "code-mode is a typed memory substrate for multi-turn, multi-session
  autonomous agents. It is not intended to outperform Bash on one-shot
  tasks — our bench harness confirms that's not its regime — and it is
  explicitly not aimed at vibe-coding workflows. It is aimed at agentic
  engineers running agent-swarm, openclaw, and comparable long-horizon
  systems where script persistence, typed reuse, and sub-agent-routed
  execution compound across hours, not seconds."

That framing is more modest than the current README but it's what the
evidence — including the sad evidence — actually supports. And it maps
cleanly onto the agent-swarm / openclaw use cases that motivated the
project in the first place.

---

## Key file references

- `packages/core/src/mcp/server.ts` — tool registration, stdio server.
- `packages/core/src/mcp/handlers/{search,run,save}.ts` — the five MCP tools.
- `packages/core/src/runner/exec.ts` — typecheck gate + BunExecutor.
- `packages/core/src/queries/search.ts` — FTS5 scoring.
- `docs/scripts.md` — script contract.
- `thoughts/taras/brainstorms/2026-04-12-code-mode.md` — original thesis,
  esp. "Q: What's the execution model constraint?" and
  "Post-Synthesis Review."
- `thoughts/taras/plans/2026-04-13-plugin-tool-bias-hooks.md` — SessionStart
  routing hook (Phase 4), the affordance fix the bench didn't test.
- `bench/results/favor-n3/report.md` — the sad data.
- `bench/results/nudged/report.md` — the forced-tool ceiling.
- `/Users/taras/Documents/code/agent-swarm/README.md` — "Agents Get Smarter
  Over Time" section; the consumer shape code-mode is actually designed for.
