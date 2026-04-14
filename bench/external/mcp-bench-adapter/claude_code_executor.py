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

        cmd_parts = list(cfg.get("command") or [])
        if not cmd_parts:
            continue
        # MCP-Bench's commands.json assumes a conda env is pre-activated so
        # bare `python …` or `uv run python …` resolves to the per-server
        # venv. Claude Code spawns MCP subprocesses with a narrow env that
        # doesn't carry the venv preamble, and uv's project resolution can
        # pick the wrong python if VIRTUAL_ENV leaks in from the parent
        # process. Bypass both by hard-binding to `<cwd>/.venv/bin/python`
        # when it exists — that's what install.sh guarantees per server.
        local_py = Path(cwd_abs) / ".venv" / "bin" / "python" if cwd_abs else None
        if local_py and local_py.exists():
            i = 0
            if cmd_parts[0] == "uv" and len(cmd_parts) > 1 and cmd_parts[1] == "run":
                i = 2
                while i < len(cmd_parts) and cmd_parts[i].startswith("--"):
                    i += 2 if cmd_parts[i] in ("--project", "--with") else 1
            if i < len(cmd_parts) and cmd_parts[i] in ("python", "python3"):
                i += 1
            cmd_parts = [str(local_py)] + cmd_parts[i:]

        # Resolve absolute path for the command so it doesn't depend on PATH
        # inheritance (Claude Code spawns MCP stdio subprocesses with a narrow
        # env by default). Fall back to `python3` if the command is bare
        # `python` and no `python` is on PATH (macOS ships python3 only).
        resolved = shutil.which(cmd_parts[0])
        if resolved is None and cmd_parts[0] == "python":
            resolved = shutil.which("python3")
        cmd0 = resolved or cmd_parts[0]

        # Build the env we hand to the MCP subprocess. Start with PATH,
        # HOME, LANG (so uv/python/node can resolve binaries and caches),
        # then layer in secret-holding vars the task asked for. We
        # *deliberately* do not forward VIRTUAL_ENV — if we inherit the
        # harness's own venv, uv's `run` picks that up instead of walking
        # from `cwd` to the per-server `.venv`, and the module import fails.
        child_env = {
            k: os.environ[k]
            for k in ("PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL",
                      "USER", "LOGNAME", "TMPDIR")
            if k in os.environ
        }
        # Strip the harness venv's bin from PATH too — otherwise tools that
        # auto-detect `python3` via PATH would short-circuit to it.
        host_venv_bin = os.environ.get("VIRTUAL_ENV", "").rstrip("/") + "/bin"
        if host_venv_bin and "PATH" in child_env:
            parts = [p for p in child_env["PATH"].split(":") if p != host_venv_bin]
            child_env["PATH"] = ":".join(parts)
        child_env.update(env_map)

        # Claude Code (2.1.108) silently ignores the `cwd` field for stdio
        # MCP servers — the child is spawned in the parent's workdir, not
        # the one declared here. `env` IS honored; only `cwd` is dropped.
        # That breaks any server whose args contain a relative file path
        # (e.g. Math MCP's `node build/index.js`), with no visible error
        # because stderr is also swallowed — the `init` event just reports
        # `status: failed`. Python `-m <module>` entries accidentally mask
        # the bug because the interpreter resolves modules via its own
        # prefix/sys.path rather than cwd.
        #
        # We work around it by pre-resolving each arg that both (a) looks
        # like a path (no leading `-`) and (b) exists as a file relative
        # to `cwd_abs`. Everything else passes through unchanged.
        rest_args = list(cmd_parts[1:])
        if cwd_abs:
            rewritten: List[str] = []
            for a in rest_args:
                if a and not a.startswith("-") and not Path(a).is_absolute():
                    candidate = (Path(cwd_abs) / a).resolve()
                    if candidate.exists():
                        rewritten.append(str(candidate))
                        continue
                rewritten.append(a)
            rest_args = rewritten

        servers[key] = {
            "command": cmd0,
            "args": rest_args,
            "env": child_env,
            # Kept for MCPs that might start honouring it in a later CC
            # version — harmless today since Claude Code drops it.
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
        # 900s default: single Wikipedia task on sonnet-4-6 runs ~294s
        # real-time (see bench-log/2026-04-14-mcpbench-first-real-baseline.md),
        # so 300s was already eating into the margin and killed the earlier
        # run mid-thought. 900 leaves headroom for larger multi-MCP tasks
        # and is still short enough that a dead process gets reaped in
        # reasonable time.
        self.timeout_s = int(os.environ.get("CLAUDE_CODE_TIMEOUT_S", "900"))
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

            settings_path = workdir / "_settings.json"
            settings_path.write_text(json.dumps(settings))

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
            # Force Claude Code to use OAuth (CLAUDE_CODE_OAUTH_TOKEN) instead
            # of falling through to ANTHROPIC_API_KEY — the API-key path has
            # different (often lower) monthly caps than the subscription OAuth.
            child_env.pop("ANTHROPIC_API_KEY", None)
            if block_mode:
                child_env["CODE_MODE_MCP_BLOCK"] = "1"

            # Use --mcp-config + --settings + --strict-mcp-config so Claude
            # loads only our scoped config without us having to override HOME
            # (HOME must stay real so child MCP servers see their uv/pip
            # caches under $HOME/.cache and don't re-fetch deps from scratch).
            args = [
                shutil.which("claude") or "claude",
                "--dangerously-skip-permissions",
                "--output-format", "stream-json", "--verbose",
                "--model", self.model,
                "--mcp-config", str(workdir / ".mcp.json"),
                "--settings", str(settings_path),
                "--strict-mcp-config",
                "-p", task,
            ]

            t0 = time.time()
            stream = await self._run(args, cwd=str(workdir), env=child_env,
                                     timeout_s=self.timeout_s, capture_stream=True)
            wall_s = time.time() - t0

            parsed = self._parse_stream(stream, wall_s)
            # Debug aid: when `CLAUDE_CODE_KEEP_WORKDIR=1`, drop the raw
            # stream-json and a truncated parse into the workdir and skip
            # the cleanup in `finally`. Essential for post-run inspection
            # of denials, tool mix, and judge scoring.
            if os.environ.get("CLAUDE_CODE_KEEP_WORKDIR") == "1":
                (workdir / "_stream.jsonl").write_text(stream)
                (workdir / "_parsed.json").write_text(
                    json.dumps(parsed, indent=2)[:5000]
                )
                logger.warning("[DEBUG] preserved workdir: %s", workdir)
            return parsed
        finally:
            if os.environ.get("CLAUDE_CODE_KEEP_WORKDIR") != "1":
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
        # Map tool_use id → index in `execution_results`, so the matching
        # `tool_result` (arriving in a later `user` event) can backfill
        # `success`. Without this, MCP-Bench's `tool_call_success_rate`
        # metric stays pinned at 0.0 for every run.
        tool_use_by_id: Dict[str, int] = {}
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
                        entry = {
                            "tool_name": block.get("name", "?"),
                            "tool_input": block.get("input", {}),
                            "round": rounds,
                            # Optimistic default — flipped on matching
                            # tool_result.is_error below.
                            "success": True,
                        }
                        tool_use_id = block.get("id")
                        if isinstance(tool_use_id, str) and tool_use_id:
                            tool_use_by_id[tool_use_id] = len(execution_results)
                        execution_results.append(entry)
                usage = msg.get("usage", {})
                self.total_prompt_tokens += int(usage.get("input_tokens", 0))
                self.total_output_tokens += int(usage.get("output_tokens", 0))
            elif t == "user":
                msg = evt.get("message", {})
                for block in msg.get("content", []):
                    if block.get("type") == "tool_result":
                        tool_use_id = block.get("tool_use_id")
                        is_error = bool(block.get("is_error"))
                        if isinstance(tool_use_id, str) and tool_use_id in tool_use_by_id:
                            execution_results[tool_use_by_id[tool_use_id]]["success"] = not is_error
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
