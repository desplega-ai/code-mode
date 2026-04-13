You have access to a `code-mode` MCP server that exposes these tools:

- `search` — find indexed scripts + symbols by FTS5 query
- `list_sdks` — list every indexed SDK (stdlib, user, generated)
- `query_types` — search indexed symbol signatures (functions/types/etc.)
- `run` — execute a saved script by name, or inline source
- `save` — persist a TypeScript script into the workspace

Please do the following, using ONLY the MCP tools (not shell commands):

1. Call `list_sdks` and report how many SDKs are indexed and their names.
2. Call `search` with the query `"greet"` and describe the single hit.
3. Call `run` with `{ mode: "named", name: "greet", argsJson: "{\"name\":\"claude\"}" }`
   and report the `greeting` string from the result.
4. Call `query_types` with the pattern `"filter"` and report the signature
   of the `filter` function it finds.

Answer in a concise bulleted list. Do not write files, do not run bash.
