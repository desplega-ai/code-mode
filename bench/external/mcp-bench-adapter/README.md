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
export CLAUDE_CODE_MODEL=claude-sonnet-4-6   # or claude-opus-4-6
export CLAUDE_CODE_TIMEOUT_S=300

# Plugin path (only needed for codemode-block variant; required for the
# PreToolUse hook that enforces blocking — claude-code's --plugin-dir
# alone doesn't register PreToolUse hooks, so we wire it directly).
export CODE_MODE_PLUGIN_DIR=/path/to/code-mode/plugins/code-mode

# Judge — pick ONE of:
#  (a) regular OpenAI (recommended; requires applying judge-openai.patch).
export OPENAI_API_KEY=...
export JUDGE_MODEL=gpt-5-mini   # or any chat-completions model your key has
#  (b) Azure OpenAI (upstream default — leaderboard-comparable with o4-mini).
# export AZURE_OPENAI_API_KEY=...
# export AZURE_OPENAI_ENDPOINT=...

# Per-task MCP server keys (see mcp_servers/api_key)
```

## Installation

```bash
# 1. Clone upstream MCP-Bench (Apache-2.0).
git clone https://github.com/Accenture/mcp-bench.git
cd mcp-bench

# 2. Drop in the two new files.
cp /path/to/code-mode/bench/external/mcp-bench-adapter/claude_code_executor.py agent/
cp /path/to/code-mode/bench/external/mcp-bench-adapter/claude_code_provider.py llm/

# 3. Apply the patches (order matters: upstream first, then optional ones).
git apply /path/to/code-mode/bench/external/mcp-bench-adapter/upstream.patch
# Required if you'll run with --distraction-count 0 (upstream bug — commands_config
# is referenced unconditionally but only loaded when distractions are enabled).
git apply /path/to/code-mode/bench/external/mcp-bench-adapter/mcpbench-bugfix.patch
# Optional: swap judge from Azure to regular OpenAI (parameterizable via JUDGE_MODEL env).
git apply /path/to/code-mode/bench/external/mcp-bench-adapter/judge-openai.patch

# 4. Install MCP-Bench's 28 MCP servers + Python deps (~10 min).
conda create -n mcpbench python=3.10
conda activate mcpbench
cd mcp_servers && bash ./install.sh && cd ..

# 5. Install Claude Code + code-mode globally.
npm i -g @anthropic-ai/claude-code @desplega/code-mode
```

## Sanity run

```bash
# Single task, baseline.
python run_benchmark.py \
  --models claude-code-baseline \
  --task-files tasks/mcpbench_tasks_single_runner_format.json \
  --max-tasks 1
```

## Known limitations (cut-1)

- **Double-spawning MCP servers**: MCP-Bench's `server_manager` keeps its own MCP connections open even though Claude Code spawns its own. Wasteful but isolates the variants cleanly.
- **No CODE_MODE_MCP_HINT variant yet**: only baseline + block. Adding a third (`hint` mode, where code-mode is registered but not blocking) is a one-line factory entry — deferred until block run produces a baseline number.
- **No tool-call execution_results detail**: we capture the tool *invocations* but not their MCP-side return values (those live in `tool_result` blocks which we put into `accumulated_information` as text). The judge reads `accumulated_information` so it has the data; the structured `execution_results` field is sparser than what `TaskExecutor` produces.
