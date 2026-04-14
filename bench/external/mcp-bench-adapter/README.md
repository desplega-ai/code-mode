# Claude Code adapter for MCP-Bench

Wires `claude -p` (Anthropic's CLI agent) into MCP-Bench as two model variants
so we can score code-mode against an external public bench (28 MCPs / 250 tools).

## Variants

| Model name | What it does |
|---|---|
| `claude-code-baseline` | Bare Claude Code with the task's MCPs declared via `.mcp.json`. Claude drives its own tool-use loop. |
| `claude-code-codemode-block` | Same + `@desplega/code-mode` MCP, with `CODE_MODE_MCP_BLOCK=1` so direct calls to the task's MCPs are denied — model must route through `mcp__code-mode__run`. |

The variant is selected via env (`CODE_MODE_VARIANT`), set automatically by `LLMFactory.create_llm_provider` when the model name is one of the two above.

## How it plugs in

- **`agent/claude_code_executor.py`** — duck-typed twin of `TaskExecutor`. Builds a `.mcp.json` from `server_manager.server_configs` (translating MCP-Bench's `commands.json` schema → Claude Code's), spawns `claude -p --output-format stream-json --verbose`, parses the stream, returns the dict shape MCP-Bench's judge expects (`solution`, `accumulated_information`, `execution_results`, `total_rounds`, token counts).
- **`llm/claude_code_provider.py`** — sentinel `LLMProvider` whose only job is to be detectable by `isinstance()` in the runner. Calling `get_completion()` raises (it should never be called).
- **`llm/factory.py`** — adds the two model configs (gated on `CLAUDE_CODE_OAUTH_TOKEN`) and a `claude_code` branch in `create_llm_provider`.
- **`benchmark/runner.py`** — single branch around line 489: if `isinstance(llm_provider, ClaudeCodeProvider)`, swap `TaskExecutor` for `ClaudeCodeExecutor`. Everything else (judge, telemetry, retries) is untouched.

## Required env

```bash
# Claude Code
export CLAUDE_CODE_OAUTH_TOKEN=...
export CLAUDE_CODE_MODEL=claude-sonnet-4-6       # or claude-opus-4-6
export CLAUDE_CODE_TIMEOUT_S=900                 # executor default since
                                                 # 2026-04-14; baseline
                                                 # wikipedia_000 runs ~294s,
                                                 # so 300s had no margin.

# Plugin path (only needed for codemode-block variant; required for the
# PreToolUse hook that enforces blocking — claude-code's --plugin-dir
# alone doesn't register PreToolUse hooks, so we wire it directly).
export CODE_MODE_PLUGIN_DIR=/path/to/code-mode/plugins/code-mode

# Judge — pick ONE of:
#  (a) Regular OpenAI (recommended; requires judge-openai.patch, AND
#      llm-provider-reasoning-tokens.patch when JUDGE_MODEL is gpt-5*
#      or an o-series reasoning model — otherwise the `max_tokens`
#      param gets a 400 and the retry loop hides it).
export OPENAI_API_KEY=...
export JUDGE_MODEL=gpt-5-mini   # or any chat-completions model your key has
#  (b) Azure OpenAI (upstream default — leaderboard-comparable with o4-mini).
# export AZURE_OPENAI_API_KEY=...
# export AZURE_OPENAI_ENDPOINT=...

# Debug aid: preserve per-task working directories (with `_stream.jsonl`
# and a truncated `_parsed.json`) instead of cleaning them up. Read by
# `ClaudeCodeExecutor.execute`. Essential for post-run inspection of
# hook denials, tool mix, and judge scoring errors.
# export CLAUDE_CODE_KEEP_WORKDIR=1

# Opt-in: when set, the executor pops `CLAUDE_CODE_OAUTH_TOKEN` from
# the child env before spawning `claude -p`, so Claude Code falls
# through to macOS Keychain auth (refreshable, managed by the
# interactive `claude login` flow). The parent process still needs a
# non-empty `CLAUDE_CODE_OAUTH_TOKEN` to pass MCP-Bench's
# `llm/factory.py` env-presence gate — any sentinel like "keychain"
# works. Useful when the bench/.env token hits its own subscription
# cap but a developer's interactive token on another subscription
# still has budget.
# export CLAUDE_CODE_OAUTH_TOKEN=keychain
# export CLAUDE_CODE_USE_KEYCHAIN=1

# Per-task MCP server keys (see mcp_servers/api_key)
```

## Patch inventory

Everything in this directory is either a drop-in file or a `git apply`-able
patch against a clean `Accenture/mcp-bench` checkout. Keep the list and
the README in sync whenever a new patch lands.

| File | Target | Required? | What it does |
|---|---|---|---|
| `claude_code_executor.py`         | `agent/claude_code_executor.py` | **required** | Duck-typed `TaskExecutor` that spawns `claude -p`, parses the stream-json, and returns the dict shape MCP-Bench's judge expects. Includes `CLAUDE_CODE_KEEP_WORKDIR=1` debug mode, per-`tool_use` `success` pairing, `CLAUDE_CODE_USE_KEYCHAIN=1` opt-in for macOS Keychain auth fallthrough, and an absolutise-relative-args pass that works around Claude Code silently ignoring the `.mcp.json` `cwd` field for stdio servers. |
| `claude_code_provider.py`         | `llm/claude_code_provider.py`   | **required** | Sentinel `LLMProvider` so the runner can `isinstance`-switch on the Claude Code variants. |
| `upstream.patch`                  | `benchmark/runner.py`, `llm/factory.py` | **required** | Wires the two model configs (`claude-code-baseline`, `claude-code-codemode-block`) + the executor-swap branch. |
| `mcpbench-bugfix.patch`           | `benchmark/runner.py` | **required for `--distraction-count 0`** | Loads `commands_config` unconditionally — upstream references it even when distractions are disabled, so without this the runner crashes on any zero-distraction run. |
| `judge-openai.patch`              | `benchmark/runner.py` | optional | Lets the judge use regular OpenAI (or any OpenAI-compatible `OPENAI_BASE_URL`) when `OPENAI_API_KEY` is set, falling back to Azure. Judge model is `JUDGE_MODEL` env var (default `o4-mini` for upstream comparability). |
| `llm-provider-reasoning-tokens.patch` | `llm/provider.py` | required when `JUDGE_MODEL` is a reasoning model | Routes `max_tokens` → `max_completion_tokens` for gpt-5* and o-series models across *both* Azure and non-Azure providers. Upstream only special-cased Azure + hardcoded name list. |
| `presync-venvs.sh`                | script | required | Creates a `.venv` under every `mcp_servers/<server>/`. `install.sh` doesn't, and the executor hard-binds to `<cwd>/.venv/bin/python` because uv's project resolution is flaky when Claude Code spawns stdio MCPs with a narrow env. |
| `env.smoke.example`               | template | optional | Shell env template — source it after editing OAuth and any per-server API keys. |

## Installation

```bash
# 1. Clone upstream MCP-Bench (Apache-2.0).
git clone https://github.com/Accenture/mcp-bench.git
cd mcp-bench

# Point ADAPTER at this directory in the code-mode repo so the steps
# below are cut-and-paste.
ADAPTER=/path/to/code-mode/bench/external/mcp-bench-adapter

# 2. Drop in the two new files.
cp "$ADAPTER/claude_code_executor.py" agent/
cp "$ADAPTER/claude_code_provider.py" llm/

# 3. Apply the patches. Apply upstream.patch FIRST — the rest patch
#    files it touches. Optional patches can be skipped if you don't need
#    the feature they unlock.
git apply "$ADAPTER/upstream.patch"                         # required
git apply "$ADAPTER/mcpbench-bugfix.patch"                  # required for --distraction-count 0
git apply "$ADAPTER/judge-openai.patch"                     # optional: regular OpenAI judge
git apply "$ADAPTER/llm-provider-reasoning-tokens.patch"    # required if JUDGE_MODEL is gpt-5* / o-series

# 4. Install MCP-Bench's 28 MCP servers + Python deps (~10 min).
#    `uv venv` works as a drop-in for conda and is faster.
uv venv .venv --python 3.10 && source .venv/bin/activate
uv pip install -r mcp_servers/requirements.txt openai
cd mcp_servers && bash ./install.sh && cd ..

# 5. Pre-sync each per-server venv.
bash "$ADAPTER/presync-venvs.sh" .

# 6. Install Claude Code + code-mode globally.
npm i -g @anthropic-ai/claude-code @desplega/code-mode

# 7. Seed your env and go.
cp "$ADAPTER/env.smoke.example" .env.smoke
$EDITOR .env.smoke
```

## Re-sync checklist (adapter → fork)

When you change anything in this adapter directory, propagate it to an
existing MCP-Bench fork before the next run:

1. `cp "$ADAPTER/claude_code_executor.py" agent/` — always. This file
   is rev'd most often (timeout defaults, stream parser, `success`
   pairing, workdir preservation).
2. `cp "$ADAPTER/claude_code_provider.py" llm/` — only if the sentinel
   class shape changed.
3. For `*.patch` changes, the cleanest path is: `git -C <fork> reset
   --hard <base>`, re-`cp` the two files, then re-apply patches in the
   order listed above. This is what the install script does on a fresh
   clone.
4. After any change, smoke-run `python run_benchmark.py --models
   claude-code-baseline --tasks-file tasks/_smoke1.json
   --distraction-count 0` and confirm you see judge scores (not a
   harness-level error). If you changed `claude_code_executor.py`,
   also run with `CLAUDE_CODE_KEEP_WORKDIR=1` and spot-check
   `_stream.jsonl` for the expected tool mix.

## Sanity run

```bash
# Single task, baseline.
python run_benchmark.py \
  --models claude-code-baseline \
  --tasks-file tasks/_smoke1.json \
  --distraction-count 0
```

See `bench-log/2026-04-14-mcpbench-first-real-baseline.md` in the
code-mode repo for the expected output shape, cost, and telemetry on
`wikipedia_000`.

## Known limitations (cut-1)

- **Double-spawning MCP servers**: MCP-Bench's `server_manager` keeps its own MCP connections open even though Claude Code spawns its own. Wasteful but isolates the variants cleanly.
- **No CODE_MODE_MCP_HINT variant yet**: only baseline + block. Adding a third (`hint` mode, where code-mode is registered but not blocking) is a one-line factory entry — deferred until block run produces a baseline number.
- **`accumulated_information` is the judge's source of truth**: we capture tool *invocations* into `execution_results` (with `success` pairing as of 2026-04-14), but the MCP-side return values live in the `tool_result` blocks that we flatten into `accumulated_information` as text. The judge reads `accumulated_information`, so it has everything — just know the structured `execution_results` field is sparser than what `TaskExecutor` produces.
