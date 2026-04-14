---
date: 2026-04-15
external_bench: mcp-bench (Accenture)
models: [claude-sonnet-4-6 via claude-code-* variants]
variants: [n/a — debug session, not a benchmarked run]
tasks: [unit_converter_math_mcp_000]
total_runs: 2 (one failed multi-MCP, one minimal repro)
total_cost_usd: ~0.37
status: root-caused + adapter-side fix landed
related:
  - bench-log/2026-04-14-mcpbench-block-fixed.md
  - bench/external/mcp-bench-adapter/claude_code_executor.py
---

# 2026-04-15 — Debug: Claude Code ignores `.mcp.json` `cwd` for stdio MCPs

Yesterday's "quick single round" multi-MCP attempt on
`unit_converter_math_mcp_000` produced unusable signal: both variants did
0 tool calls in 1 turn because **both required MCPs failed to start
inside Claude Code**, and the agents fell back to bare math reasoning.
Unit_Converter had a known-trivial cause (missing per-server `.venv/`).
Math_MCP was the mystery — it's a Node server, `build/index.js` runs
fine when spawned manually, MCP-Bench's own server manager connects to
it and discovers 13 tools in the same run where Claude Code marks it
`failed`.

Today's background debug run nailed it. This is a bench-adapter
post-mortem, not a benchmarked run — no judge scores to compare.

## What ran

Background debug sub-agent (claude-sonnet-4-6) with a scoped brief:
reproduce the failure in isolation, capture child-process stderr via a
shim, A/B env vars (NVM_BIN, NODE_PATH, stdin), compare Math_MCP
(failing) vs Time_MCP (connected in same run), fall back to a pure
`claude -p` repro if nothing else worked. Sub-agent spent ~3 minutes
and ~$0.20 across two real `claude -p` probes against sonnet-4-6.

## Root cause (proven with a shim)

**Claude Code 2.1.108 silently ignores the `cwd` field in `.mcp.json`
for stdio MCP servers.** The child process is spawned in the parent's
workdir, not the declared one. `env` IS honored. `cwd` is dropped.

The debug sub-agent proved this directly: it replaced `.mcp.json`'s
`command` with a shim script whose first line was `pwd`, then spawned
`claude -p`. The shim's `pwd` output was `/tmp/claude-math-repro`
(the harness workdir), **not** the `cwd` declared in `.mcp.json`. Node
then hit:

```
Error: Cannot find module '/private/tmp/claude-math-repro/build/index.js'
```

Changing `args` to the absolute path `.../math-mcp/build/index.js`
(leaving `cwd` in place) → `status: "connected"`. Dispositive.

## Why Time_MCP worked on the same mechanism

Time_MCP's command is `python -m mcp_server_time`. Python's `-m`
resolves the module via `sys.path` / interpreter prefix, which is
driven by the absolute interpreter path
(`.../time-mcp/.venv/bin/python`). Cwd is irrelevant. Math_MCP's
entry is a **file path** (`build/index.js`), which Node resolves
relative to cwd → immediate crash under broken cwd handling.

So the failure pattern in a mixed multi-MCP run isn't about env,
PATH, or NVM. It's about whether the server's command is a module
spec or a file-path arg. That's a *very* non-obvious split.

## Fix (adapter-side)

Minimal, surgical, just landed in
`bench/external/mcp-bench-adapter/claude_code_executor.py` and sync'd
to the active fork: before writing `.mcp.json`, walk each arg and
rewrite any token that (a) doesn't start with `-` and (b) exists as a
file relative to `cwd_abs` into an absolute path. Everything else
passes through unchanged.

```python
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
```

The `exists()` guard keeps the rewrite harmless for non-file args
(flag values, literal strings). The `cwd` field is still written to
`.mcp.json` — kept for the day Claude Code starts honouring it, a
no-op until then.

Also worth filing an upstream bug: Claude Code's stdio MCP spawner
should either honour `cwd` or warn loudly when it's present but
ignored. The current behaviour — silently spawning in the wrong
directory and reporting `status: failed` with no stderr — took a
dedicated debug session to pinpoint. Nobody running adapters on top
of `.mcp.json` should have to discover this via shim scripts.

## Learnings (bench-log canon)

1. **Claude Code 2.1.108 silently ignores the `cwd` field in
   `.mcp.json` for stdio MCP servers.** It honours `env` but spawns
   the child in the parent's workdir. Repro: point the command at a
   shim that prints `pwd` before exec'ing the real binary — the
   shim's `pwd` is the harness workdir, not the declared one.

2. **Relative file-path args in stdio MCP entries are a landmine on
   Claude Code.** Any `node build/index.js`-style server (i.e. every
   TS/JS MCP shipped as a build artifact) fails with MODULE_NOT_FOUND
   when spawned via `.mcp.json`, even though the server binary is
   healthy and MCP-Bench's own persistent manager spawns it fine.
   Absolutise positional file args before handing `.mcp.json` to
   `claude -p`.

3. **Python `-m module` MCP entries accidentally mask this bug.** The
   interpreter resolves the module via its prefix/sys.path, not cwd.
   In mixed multi-MCP runs some servers "connect" and others "fail"
   purely based on whether they use a module spec or a file path —
   the pattern looks like flaky infra, but it's deterministic.

4. **Claude Code swallows stderr from failed MCP stdio spawns.** The
   `init` event reports `status: failed` — no reason, no log line, no
   exit code in the stream-json. Wrapping the command in a shim that
   tees stderr to a file is the only way to see the child's actual
   crash. Add `CLAUDE_CODE_MCP_SPAWN_DEBUG`-style support to the
   adapter if we hit this again.

5. **MCP-Bench's `commands.json` authors assume "run from the server
   directory"** — every path is relative to `cwd`. Any adapter that
   hands these commands to a spawner with broken cwd handling needs
   to pre-resolve, not pass through.

## Separate but related: Unit_Converter

Still dead on the fork, but the cause is boring and un-tangled from
the cwd bug: `mcp_servers/unit-converter-mcp/.venv/` doesn't exist,
so the executor's per-server-venv binding (lines 75–84) skips the
rewrite and falls through to `shutil.which("python")` → harness venv
→ `ModuleNotFoundError: No module named 'unit_converter_mcp'`.

Fix when we want it: rerun `presync-venvs.sh` on this one server.
Takes a minute, not included in today's scope.

## Next steps

1. **Apply `presync-venvs.sh` to `unit-converter-mcp`.** Unblocks the
   Python side of the HVAC task.
2. **Re-run `unit_converter_math_mcp_000`, both variants.** This
   should now actually exercise the multi-MCP path. First benchmarked
   numbers where code-mode's typed-SDK routing has a theoretical
   advantage (cross-server compose).
3. **File upstream bug against Claude Code** for the silent `cwd`
   drop. Low priority for us — the workaround is 10 lines — but
   other adapter authors will trip on it.
4. **Keep an eye on `commands.json` for other file-path args.** The
   spot-check during the fix only covered the 5 servers our recent
   runs touched. Math_MCP was the first file-path entry we hit; more
   will surface as we expand task coverage.

## Cost ledger

- Debug sub-agent: ~$0.20 (2× `claude -p` probes on sonnet-4-6)
- Previous (invalid) multi-MCP run: ~$0.34 combined (baseline $0.18
  + block $0.16, both unusable signal because of the cwd bug)
- **Session total: ~$0.54**, all of it diagnostic.
