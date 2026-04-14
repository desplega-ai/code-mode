"""Claude Code executor — drop-in replacement for TaskExecutor.

Shells out to `claude -p` (Anthropic's CLI agent) instead of running
MCP-Bench's plan-then-dispatch loop. Claude Code drives its own tool-use
loop against MCP servers configured via .mcp.json, which we synthesise
from MCP-Bench's `server_manager.server_configs`.

Two variants, selected via env CODE_MODE_VARIANT (set by the runner):
  - `baseline`        : MCP-Bench's servers only.
  - `codemode-block`  : same + @desplega/code-mode MCP, with
                        CODE_MODE_MCP_BLOCK=1 so direct calls to other
                        MCPs are denied and the model must route through
                        mcp__code-mode__run.

The result dict mirrors what MCP-Bench's judge consumes:
  solution, accumulated_information, execution_results, total_rounds,
  planning_json_compliance, total_{prompt,output,_}_tokens.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def _build_mcp_json(server_configs: List[Dict[str, Any]], repo_root: Path,
                    include_code_mode: bool) -> Dict[str, Any]:
    """Translate MCP-Bench's *normalized* server_configs into Claude Code's
    .mcp.json schema. Shape produced by `BenchmarkRunner.map_server_name_to_config`:
      - name: str
      - command: list[str] (already split)
      - env: dict[str, str] (already populated with secret values)
      - cwd: str — usually `mcp_servers/<dir>` relative to repo root
      - transport: 'http' (optional) + port + endpoint
    `repo_root` is the mcp-bench checkout so we can resolve relative cwds."""
    servers: Dict[str, Any] = {}
    for cfg in server_configs:
        name = cfg["name"]
        # Sanitise — Claude Code's mcp_<name>__ namespace requires non-spaces.
        key = name.replace(" ", "_").replace("/", "_")

        cwd_rel = cfg.get("cwd") or ""
        if cwd_rel and not Path(cwd_rel).is_absolute():
            cwd_abs = str((repo_root / cwd_rel).resolve())
        else:
            cwd_abs = cwd_rel or None

        env_map = cfg.get("env") or {}

        if cfg.get("transport") == "http":
            port = cfg.get("port")
            endpoint = cfg.get("endpoint", "/mcp")
            servers[key] = {"type": "http", "url": f"http://localhost:{port}{endpoint}"}
            continue

        cmd_parts = cfg.get("command") or []
        if not cmd_parts:
            continue
        servers[key] = {
            "command": cmd_parts[0],
            "args": list(cmd_parts[1:]),
            **({"env": dict(env_map)} if env_map else {}),
            **({"cwd": cwd_abs} if cwd_abs else {}),
        }

    if include_code_mode:
        servers["code-mode"] = {"command": "code-mode", "args": ["mcp"]}

    return {"mcpServers": servers}


class ClaudeCodeExecutor:
    """Duck-typed twin of agent.executor.TaskExecutor.

    Same constructor signature so runner.py can swap us in with a
    one-line branch. We ignore `concurrent_summarization` (Claude Code
    handles synthesis internally)."""

    def __init__(
        self,
        llm_provider: Any,  # ClaudeCodeProvider sentinel — unused.
        server_manager: Any,
        concurrent_summarization: bool = False,
    ) -> None:
        self.llm = llm_provider
        self.server_manager = server_manager
        self.all_tools = getattr(server_manager, "all_tools", {})

        self.variant = os.environ.get("CODE_MODE_VARIANT", "baseline")
        self.model = os.environ.get("CLAUDE_CODE_MODEL", "claude-sonnet-4-6")
        self.timeout_s = int(os.environ.get("CLAUDE_CODE_TIMEOUT_S", "300"))
        self.repo_root = Path(__file__).resolve().parents[1]

        # Token tallies surfaced via judge fields.
        self.total_output_tokens = 0
        self.total_prompt_tokens = 0
        self.total_tokens = 0

    async def execute(self, task: str) -> Dict[str, Any]:
        """Run a single MCP-Bench task end-to-end via `claude -p`."""
        include_code_mode = self.variant != "baseline"
        block_mode = self.variant == "codemode-block"

        mcp_cfg = _build_mcp_json(
            self.server_manager.server_configs,
            self.repo_root,
            include_code_mode,
        )

        workdir = Path(tempfile.mkdtemp(prefix="mcpbench-claude-"))
        try:
            (workdir / ".mcp.json").write_text(json.dumps(mcp_cfg))

            settings: Dict[str, Any] = {
                "enableAllProjectMcpServers": True,
                "enabledMcpjsonServers": list(mcp_cfg["mcpServers"].keys()),
            }
            if block_mode:
                # Same workaround we use in our internal bench: --plugin-dir
                # alone doesn't register PreToolUse hooks (claude-code bug),
                # so we register the hook directly. Requires CODE_MODE_PLUGIN_DIR
                # to point at the mounted plugins/code-mode dir.
                plugin_dir = os.environ.get("CODE_MODE_PLUGIN_DIR")
                if plugin_dir:
                    settings["hooks"] = {
                        "PreToolUse": [{
                            "matcher": "mcp__.*",
                            "hooks": [{
                                "type": "command",
                                "command": f"node {plugin_dir}/hooks/pretooluse.mjs",
                            }],
                        }],
                    }

            claude_home = workdir / ".claude"
            claude_home.mkdir(parents=True)
            (claude_home / "settings.json").write_text(json.dumps(settings))
            (workdir / ".claude.json").write_text(
                '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}\n'
            )

            if include_code_mode:
                # Init code-mode workspace + reindex so SDKs are introspected
                # for the MCP servers we just declared.
                await self._run(
                    [shutil.which("code-mode") or "code-mode", "init", str(workdir)],
                    cwd=str(workdir), env=os.environ.copy(), timeout_s=60,
                )
                await self._run(
                    [shutil.which("code-mode") or "code-mode", "reindex"],
                    cwd=str(workdir), env=os.environ.copy(), timeout_s=60,
                )

            child_env = os.environ.copy()
            child_env["HOME"] = str(workdir)
            if block_mode:
                child_env["CODE_MODE_MCP_BLOCK"] = "1"

            args = [
                shutil.which("claude") or "claude",
                "--dangerously-skip-permissions",
                "--output-format", "stream-json", "--verbose",
                "--model", self.model,
                "-p", task,
            ]

            t0 = time.time()
            stream = await self._run(args, cwd=str(workdir), env=child_env,
                                     timeout_s=self.timeout_s, capture_stream=True)
            wall_s = time.time() - t0

            return self._parse_stream(stream, wall_s)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    async def _run(
        self,
        argv: List[str],
        cwd: str,
        env: Dict[str, str],
        timeout_s: int,
        capture_stream: bool = False,
    ) -> str:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd, env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError(f"claude-code subprocess timed out after {timeout_s}s")
        if proc.returncode != 0 and not capture_stream:
            raise RuntimeError(
                f"command failed (rc={proc.returncode}): {' '.join(argv[:3])}\n"
                f"stderr: {stderr.decode('utf-8', errors='replace')[:500]}"
            )
        return stdout.decode("utf-8", errors="replace")

    def _parse_stream(self, stream: str, wall_s: float) -> Dict[str, Any]:
        """Walk Claude Code stream-json events and synthesise the dict
        shape MCP-Bench's judge expects."""
        execution_results: List[Dict[str, Any]] = []
        accumulated: List[str] = []
        final_text = ""
        rounds = 0
        cost_usd: Optional[float] = None

        for line in stream.splitlines():
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                continue

            t = evt.get("type")
            if t == "assistant":
                rounds += 1
                msg = evt.get("message", {})
                for block in msg.get("content", []):
                    if block.get("type") == "text":
                        text = block.get("text", "")
                        if text:
                            final_text = text
                            accumulated.append(f"[assistant] {text}")
                    elif block.get("type") == "tool_use":
                        execution_results.append({
                            "tool_name": block.get("name", "?"),
                            "tool_input": block.get("input", {}),
                            "round": rounds,
                        })
                usage = msg.get("usage", {})
                self.total_prompt_tokens += int(usage.get("input_tokens", 0))
                self.total_output_tokens += int(usage.get("output_tokens", 0))
            elif t == "user":
                msg = evt.get("message", {})
                for block in msg.get("content", []):
                    if block.get("type") == "tool_result":
                        content = block.get("content", "")
                        if isinstance(content, list):
                            content = " ".join(
                                c.get("text", "") for c in content if isinstance(c, dict)
                            )
                        accumulated.append(f"[tool_result] {str(content)[:2000]}")
            elif t == "result":
                cost_usd = evt.get("total_cost_usd")

        self.total_tokens = self.total_prompt_tokens + self.total_output_tokens

        return {
            "solution": final_text,
            "accumulated_information": "\n".join(accumulated),
            "accumulated_information_uncompressed": "\n".join(accumulated),
            "execution_results": execution_results,
            "total_rounds": rounds,
            "planning_json_compliance": 1.0,
            "total_prompt_tokens": self.total_prompt_tokens,
            "total_output_tokens": self.total_output_tokens,
            "total_tokens": self.total_tokens,
            # Sidecar telemetry — picked up by our wrapper script, ignored by judge.
            "_claude_code": {
                "wall_s": wall_s,
                "cost_usd": cost_usd,
                "variant": self.variant,
                "model": self.model,
            },
        }
