# code-mode MCP E2E

Smoke-tests the `@desplega/code-mode` MCP server against a real coding
agent (`claude -p`, Sonnet). The test:

1. Scaffolds a `.code-mode/` workspace via the published npm tarball.
2. Seeds a single script (`greet`) so there's something to search/run.
3. Launches `claude -p` with **only** the `code-mode` MCP server attached
   (no Bash, no Edit, no Read) — the agent's only affordance is the five
   MCP tools.
4. Feeds in `prompt.md`, which asks the agent to exercise each tool.

## Files

| File              | Purpose                                                         |
|-------------------|-----------------------------------------------------------------|
| `mcp-config.json` | Points Claude Code at `npx -y @desplega/code-mode mcp`.         |
| `setup.sh`        | Scaffolds `workspace/.code-mode/` and seeds the `greet` script. |
| `prompt.md`       | The test plan Claude must execute using MCP tools.              |
| `run.sh`          | Invokes `claude -p --mcp-config ... --mcp-debug` with prompt.   |

## Run it

```bash
./run.sh        # setup runs automatically if workspace is missing
```

The MCP server auto-starts via `npx` on first tool call. Re-running
uses the cached npm package from `~/.npm/_npx/`.

## What a passing run looks like

The agent should answer with four bullets confirming:

- `list_sdks` returned the stdlib SDK (and any generated ones).
- `search "greet"` hit one script with name `greet`, scope `script`.
- `run` of `greet` with `{ "name": "claude" }` returned
  `greeting: "hello, claude"`.
- `query_types "filter"` returned a `filter<T>(items: T[], predicate: …): T[]` signature.

`--mcp-debug` prints the raw MCP request/response frames on stderr so
you can inspect every tool call.

## Resetting

```bash
rm -rf workspace
./run.sh
```
