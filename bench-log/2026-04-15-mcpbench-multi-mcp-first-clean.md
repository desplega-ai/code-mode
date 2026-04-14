---
date: 2026-04-15
external_bench: mcp-bench (Accenture)
models: [claude-sonnet-4-6 via claude-code-baseline, claude-code-codemode-block]
variants: [claude-code-baseline, claude-code-codemode-block]
tasks: [unit_converter_math_mcp_000]
total_runs: 2 (one baseline, one block after a dedup-bypass discovery mid-session)
total_cost_usd: ~0.71
status: first-valid-multi-MCP-numbers + two-new-bugs-caught
related:
  - bench-log/2026-04-15-mcpbench-cwd-drop-debug.md
  - bench-log/2026-04-14-mcpbench-block-fixed.md
---

# 2026-04-15 — First valid multi-MCP numbers (HVAC task)

Pushing past yesterday's failed multi-MCP attempt. The HVAC energy
compute task (`unit_converter_math_mcp_000`) requires Unit_Converter +
Math_MCP + cross-server composition — a reasonable first test of
whether code-mode's typed-SDK routing buys anything on a multi-MCP
task. Result: **baseline wins on all three dimensions** on this
particular task, for reasons explained below. First valid,
benchmarked head-to-head on a multi-server MCP-Bench task.

## What it took to get here

Three unrelated blockers had to fall before the run could produce
signal. Bench-log on the debug session for the cwd issue yesterday
(`2026-04-15-mcpbench-cwd-drop-debug.md`) covers one; the rest
surfaced during this run.

1. **cwd-drop workaround** (committed yesterday, `cdf3261`). Claude
   Code 2.1.108 silently ignores the `.mcp.json` `cwd` field for
   stdio MCPs, so Math_MCP's `node build/index.js` was failing with
   MODULE_NOT_FOUND. The executor now absolutises any relative
   file-path arg before writing `.mcp.json`.

2. **Unit_Converter missing `.venv/`**. `presync-venvs.sh` skipped
   this server because its `pyproject.toml` ships without a
   `uv.lock`. Fixed by hand (`uv venv --python 3.10 && uv pip
   install -e .`). Not patching presync yet — the `uv.lock` filter
   is the right heuristic for the other 20+ servers; this one's a
   one-off.

3. **OAuth token cap + Keychain fallthrough** (new adapter feature).
   The `bench/.env` `CLAUDE_CODE_OAUTH_TOKEN` is capped until May 1.
   Tried to preflight → 400 "specified API usage limits." The
   developer's interactive Claude Code uses a different token from
   macOS Keychain which still has budget, but Claude Code's Keychain
   tokens don't work as `CLAUDE_CODE_OAUTH_TOKEN` env overrides
   (401) — they're a refreshable format, not a plain bearer.

   Added opt-in flag `CLAUDE_CODE_USE_KEYCHAIN=1`: when set, the
   executor pops `CLAUDE_CODE_OAUTH_TOKEN` from the child env before
   spawning `claude -p`, so Claude Code falls through to macOS
   Keychain auth (same path as interactive `claude`). The parent
   still needs *some* non-empty `CLAUDE_CODE_OAUTH_TOKEN` value
   because MCP-Bench's `llm/factory.py` gates the claude-code-*
   variants on env-presence — any sentinel like `keychain` works.

4. **Block-mode dedup bypass** (caught mid-session, fixed, regression
   tested). The first multi-MCP run with "block" enforcement
   produced clean baseline numbers but contaminated block numbers —
   the agent was silent-passed through the block hook after one
   denial per tool name, because the hook's session-scoped `dedup`
   state short-circuits *before* it re-evaluates the decision. That
   behaviour is correct for `hint` mode (don't spam the same hint
   over and over) but defeats `block` mode entirely: the agent only
   had to ignore one denial per tool and could route direct from
   then on. See the chronological log below.

   Fix in `plugins/code-mode/hooks/pretooluse.mjs`: on dedup-cache
   hit, for `mcp__*` tools, read config and skip the short-circuit
   when `mcpBlockMode === "block"` and the tool isn't whitelisted or
   self-exempt. Regression test covers both "repeat mcp calls in
   block mode all denied" and "hint mode still dedups repeat calls
   to one hint per session." 53/53 tests pass.

## What ran

```bash
# First run: baseline + block together.
cd ~/Documents/code/misc/mcp-bench && source .venv/bin/activate && source .env.smoke
export CLAUDE_CODE_OAUTH_TOKEN=keychain CLAUDE_CODE_USE_KEYCHAIN=1
env -u VIRTUAL_ENV CLAUDE_CODE_KEEP_WORKDIR=1 \
    CLAUDE_CODE_OAUTH_TOKEN=keychain CLAUDE_CODE_USE_KEYCHAIN=1 \
    PATH="/Users/taras/.local/bin:/Users/taras/.nvm/versions/node/v24.14.1/bin:$PATH" \
    python run_benchmark.py \
      --models claude-code-baseline claude-code-codemode-block \
      --tasks-file tasks/_smoke_multi1.json \
      --distraction-count 0
```

After the dedup-bypass fix, just the block variant rerun (baseline
numbers from the first run are valid):

```bash
env ... python run_benchmark.py \
  --models claude-code-codemode-block \
  --tasks-file tasks/_smoke_multi1.json --distraction-count 0
```

- Task: `unit_converter_math_mcp_000` (HVAC heating/cooling energy
  for 7 days of °F forecast data, cross-server compose over
  Unit_Converter + Math_MCP).
- Model: `claude-sonnet-4-6`.
- Judge: `gpt-5-mini` via OpenAI (cap bump patch + Keychain auth).
- Raw workdirs preserved via `CLAUDE_CODE_KEEP_WORKDIR=1`:
  - Baseline: `.../mcpbench-claude-tkj7mb8g`
  - Block (v1, contaminated by dedup bypass): `.../mcpbench-claude-se2efu1z`
  - Block (v2, clean enforcement): `.../mcpbench-claude-te6t_uev`

## Headline numbers

| Dimension (judge)         | baseline | block v1 † | **block v2 ‡** |
|---------------------------|----------|------------|----------------|
| task_completion_score     | 9.2      | 8.5        | **8.0**        |
| tool_selection_score      | 8.7      | 7.9        | **5.5**        |
| planning_effectiveness    | 9.0      | 7.1        | **5.4**        |
| task_fulfillment          | 9.2      | 8.4        | **7.6**        |
| grounding                 | 9.2      | 8.6        | **8.4**        |
| tool_appropriateness      | (from sub-dims) | (from sub-dims) | (from sub-dims) |
| task_success_rate         | 1.0      | 1.0        | 1.0            |
| tool_call_success_rate    | **100.00%** | 66.67% | **23.08%**     |

† Block v1: dedup bypass silently allowed repeat mcp calls, so the
agent routed direct after one denial per tool. Not a valid
measurement of code-mode routing — recorded here for the diff, not
for analysis. Do not cite these numbers as "block mode on a
multi-MCP task."

‡ Block v2: clean enforcement. Every direct Unit_Converter /
Math_MCP call denied; agent pivoted to `mcp__code-mode__run`. This
is the valid block number.

| Telemetry                 | baseline  | block v2  |
|---------------------------|-----------|-----------|
| agent wall time           | 98.4 s    | 103.3 s   |
| MCP-Bench rounds          | 37        | 24        |
| tool_use calls            | 24        | 13        |
| Claude Code cost          | **$0.31** | **$0.40** |
| cache_read tokens         | 194 k     | 268 k     |
| cache_creation tokens     | 37 k      | 56 k      |
| output tokens (SDK)       | 7,625     | 7,276     |

Block v2 is +28% cost and +38% cache_read with lower scores and
*higher* tool-call retry churn. On this task, code-mode routing is
overhead, not leverage.

## Chronological tool log (block v2, 13 calls)

```
 1.  ok   ToolSearch
 2.  DENY mcp__Unit_Converter__convert_temperature   ← hook, working
 3.  DENY mcp__Unit_Converter__convert_temperature   ← dedup fix: still denied
 4.  DENY mcp__Unit_Converter__convert_temperature
 5.  DENY mcp__Unit_Converter__convert_temperature
 6.  DENY mcp__Unit_Converter__convert_temperature
 7.  DENY mcp__Unit_Converter__convert_temperature
 8.  DENY mcp__code-mode__run   ← sandbox, NOT a hook denial (see below)
 9.  ok   mcp__code-mode__list_sdks
10.  ok   mcp__code-mode__search
11.  DENY mcp__code-mode__run   ← sandbox typecheck error
12.  DENY mcp__code-mode__run   ← sandbox crash
13.  DENY mcp__code-mode__run   ← sandbox crash
```

6/13 calls are hook denials on direct MCPs (correct block
enforcement). 4/13 are code-mode sandbox failures — separate from
the hook, explained in the next section.

## Secondary finding: code-mode `@/` path alias fails in the run sandbox

Three of four `mcp__code-mode__run` calls crashed inside code-mode's
own TypeScript sandbox, for reasons unrelated to the hook or the
bench adapter. First attempt used the documented path alias:

```ts
import { convertTemperature } from "@/sdks/.generated/Unit_Converter";
import { sum, mean } from "@/sdks/.generated/Math_MCP";
```

Error:

```
[code-mode loader] import failed: ResolveMessage: Cannot find module
'@/sdks/.generated/Unit_Converter' from
'/private/var/folders/.../T/code-mode-mcp-run-Eaa6hb/inline.ts'
```

The sandbox copies `inline.ts` to a fresh tmpdir and runs it there,
losing the workdir's tsconfig `paths` alias. The SDK files *do*
exist at
`<workdir>/.code-mode/sdks/.generated/Unit_Converter.ts` — the agent
verified this with `fs.readFileSync` in call 10. But the `@/` alias
doesn't resolve because the sandbox's inline.ts is outside the
workdir.

Subsequent attempts tried absolute paths and a `.ts` extension:

- `import ... from ".../Unit_Converter.ts"` →
  `An import path can only end with a '.ts' extension when
  'allowImportingTsExtensions' is enabled.` (typecheck error 5097)
- `import ... from ".../Unit_Converter"` → ran the logic but exited
  with code 4 ("process exited 4 without sentinel"), failing the
  sandbox's completion protocol. The stdout showed correct
  intermediate values (`SUM_RAW: 94.296`, `MEAN_RAW: 13.47`,
  per-day compute tables) — so the script *worked*, but the sandbox
  flagged it as a crash.

**Interesting cross-check:** yesterday's block-fixed wikipedia_000
run also used `@/sdks/.generated/Wikipedia` imports (same pattern)
and it worked — 7/7 `__run` calls mostly succeeded. So whatever
breaks `@/` resolution is environmental or task-specific, not
universal. Two candidates worth probing later:

- **Server names with underscores** (`Unit_Converter`, `Math_MCP`
  vs clean `Wikipedia`) may interact badly with the sandbox's
  module resolver or tsconfig `paths` glob.
- **Workdir state differences** — maybe `code-mode reindex` for
  multi-server configs produces a different tsconfig shape than
  single-server configs.

Not in scope today. Filed as a separate code-mode bug to chase.

## Tells us

- **First valid multi-MCP numbers on the external bench.** All three
  server-startup blockers (cwd, venv, auth) are dead; block mode
  enforcement is correct; the run is comparable between variants.
- **Code-mode routing *loses* on simple repetitive-tool multi-MCP
  tasks.** Block v2 is +28% cost, +38% cache_read, and loses 1.2 /
  3.2 / 3.6 points on task / tool / plan respectively. The HVAC
  task is 6 identical F→C conversions plus 3 arithmetic ops;
  wrapping that in typed-SDK `__run` scripts adds orchestration
  overhead without data-join leverage.
- **The interesting comparison is still the one we haven't done
  yet** — a task where the cross-server *composition* is what
  matters (e.g., Met Museum artwork metadata joined with Wikipedia
  article content, or a multi-server pipeline where each step's
  output feeds the next). That's where typed SDKs should pay off.
- **Code-mode's sandbox has a path-alias bug** that needs a
  separate investigation. Today's block result is bounded by how
  well the sandbox tolerates the agent's import patterns — a
  confounder we can't isolate from a single task.

## Three adapter fixes landed this session

Committed on top of yesterday's cwd-drop workaround:

1. **Dedup bypass in block mode** — `plugins/code-mode/hooks/pretooluse.mjs`
   conditions the dedup short-circuit on the route decision. Block
   mode no longer silent-passes repeat mcp calls. Regression test:
   `packages/core/test/plugin/pretooluse.test.ts`.
2. **`CLAUDE_CODE_USE_KEYCHAIN=1` opt-in** — `claude_code_executor.py`
   pops the sentinel `CLAUDE_CODE_OAUTH_TOKEN` from the child env so
   `claude -p` uses macOS Keychain auth. Factory-gate-safe.
3. **README + env.smoke.example** — document the Keychain flag and
   the re-sync protocol.

## Next steps

1. **Chase the code-mode sandbox `@/` path alias bug.** Reproduce
   outside the bench, identify whether it's server-name-related or
   workdir-state-related, fix in code-mode core. Blocks meaningful
   multi-MCP routing comparisons.
2. **Pick a multi-MCP task that rewards cross-server composition**,
   not just repetitive compute. Metropolitan Museum + Wikipedia
   (artwork metadata join) or similar. Re-run both variants once
   the sandbox is reliable.
3. **Upstream bug report** for Claude Code's `.mcp.json` `cwd`
   drop. Low priority; 10-line workaround exists.

## Cost ledger (this session)

- Baseline + block v1 run: $0.60 (0.31 + 0.29)
- Block v2 rerun: $0.40
- Preflight probes (dedup fix validation + Keychain auth test,
  Claude Code via Bash): ~$0.30
- **Session total: ~$1.30 agent + ~$0.10 judge ≈ $1.40.**
