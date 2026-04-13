/**
 * `code-mode mcp` — run code-mode as an MCP server over stdio.
 *
 * Connects the configured workspace (defaults to cwd) to a stdio transport
 * and starts listening. stderr stays free for process-level diagnostics so we
 * can log through it without corrupting JSON-RPC over stdout.
 */

import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../mcp/server.ts";

export interface McpOptions {
  path?: string;
}

export async function handler(opts: McpOptions): Promise<void> {
  const workspaceDir = resolve(opts.path ?? process.cwd());
  const server = createServer({ workspaceDir });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[code-mode mcp] listening on stdio (workspace=${workspaceDir})\n`,
  );
}
