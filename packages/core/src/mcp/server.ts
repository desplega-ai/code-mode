/**
 * code-mode MCP server.
 *
 * Exposes five tools over stdio, all delegating to Phase 4–6 internals. We use
 * the low-level `Server` from `@modelcontextprotocol/sdk/server/index.js` (not
 * `McpServer`) because `McpServer.registerTool` expects Zod schemas, and we
 * want to keep JSON Schema definitions explicit — they mirror what the
 * brainstorm + plan call out as the public tool contract.
 *
 * Result shape (per plan §489):
 *   - Every tool returns MCP-shaped content: a single text block containing
 *     the JSON-stringified structured result.
 *   - On error, returns `{ isError: true, content: [{type:'text', text: msg}] }`.
 *   - When the tool's internal result has a `logs` channel, it's folded into
 *     the `content` array as a second text block.
 */

import type { Database } from "better-sqlite3";
import { openDatabase } from "../db/open.ts";
import { VERSION } from "../version.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { migrate } from "../db/migrate.ts";
import { resolveWorkspacePaths } from "../index/reindex.ts";
import { handleSearch } from "./handlers/search.ts";
import { handleRun } from "./handlers/run.ts";
import { handleSave } from "./handlers/save.ts";
import { handleListSdks } from "./handlers/listSdks.ts";
import { handleQueryTypes } from "./handlers/queryTypes.ts";
import { existsSync } from "node:fs";

export interface CreateServerOptions {
  workspaceDir: string;
  /** Test hook — inject a DB instead of opening one from disk. */
  db?: Database;
}

export function createServer(opts: CreateServerOptions): Server {
  const server = new Server(
    {
      name: "code-mode",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const ws = resolveWorkspacePaths(opts.workspaceDir);

  // Open DB lazily per-request so a missing workspace produces a clean tool
  // error rather than a startup crash. Test hook takes precedence.
  const openDb = (): Database => {
    if (opts.db) return opts.db;
    if (!existsSync(ws.dbPath)) {
      throw new Error(
        `code-mode workspace not initialized at ${ws.workspaceDir}. Run \`code-mode init\` first.`,
      );
    }
    const db = openDatabase(ws.dbPath);
    migrate(db);
    return db;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      switch (name) {
        case "search": {
          const db = openDb();
          try {
            const out = handleSearch(db, args as never);
            return successResult(out);
          } finally {
            if (!opts.db) db.close();
          }
        }
        case "run": {
          const result = await handleRun(ws.workspaceDir, args as never);
          // Run result already has a `logs` channel — fold into content.
          return runResultToMcp(result);
        }
        case "save": {
          const result = await handleSave(ws.workspaceDir, args as never);
          if (!result.success) {
            return errorResult(
              result.error ??
                (result.diagnostics
                  ? `typecheck failed: ${result.diagnostics.length} diagnostic(s)`
                  : "save failed"),
              result,
            );
          }
          return successResult(result);
        }
        case "list_sdks": {
          const db = openDb();
          try {
            return successResult(handleListSdks(db));
          } finally {
            if (!opts.db) db.close();
          }
        }
        case "query_types": {
          const db = openDb();
          try {
            return successResult(handleQueryTypes(db, args as never));
          } finally {
            if (!opts.db) db.close();
          }
        }
        default:
          return errorResult(`unknown tool: ${name}`);
      }
    } catch (e) {
      return errorResult((e as Error).message);
    }
  });

  return server;
}

// ─────────────────────────────────────────────────────────── tool schemas ──

const TOOL_DEFS: Tool[] = [
  {
    name: "search",
    description:
      "Full-text search over indexed scripts and symbols. Returns pointers (path, name, description, scope, kind, score) — not source code. Filters `status='unusable'` scripts automatically.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text (FTS5 prefix match)." },
        scope: {
          type: "string",
          enum: ["script", "sdk", "stdlib", "generated"],
          description: "Restrict to a single scope.",
        },
        kind: {
          type: "string",
          description:
            "Restrict to a symbol kind: function|type|interface|class|const. Ignored for scripts.",
        },
        limit: { type: "number", description: "Max merged results (default 50)." },
      },
      required: ["query"],
    },
  },
  {
    name: "run",
    description:
      "Execute a saved script (mode='named'), an inline source string (mode='inline'), or source passed via stdin-equivalent (mode='stdin'). Returns { success, result, logs, ... }.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["named", "inline", "stdin"],
          description: "Execution mode.",
        },
        name: { type: "string", description: "Script name (required when mode='named')." },
        source: {
          type: "string",
          description: "TS source code (required when mode='inline'|'stdin').",
        },
        argsJson: {
          type: "string",
          description: "JSON-encoded arg to pass as main(args). Defaults to 'null'.",
        },
        timeoutMs: { type: "number" },
        maxMemoryMb: { type: "number" },
        maxCpuSec: { type: "number" },
        maxOutputBytes: { type: "number" },
      },
      required: ["mode"],
    },
  },
  {
    name: "save",
    description:
      "Persist a script to `.code-mode/scripts/<name>.ts`, typechecks it, and reindexes on success. Returns diagnostics on typecheck failure (file removed).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        source: { type: "string", description: "TypeScript source to persist." },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        overwrite: { type: "boolean" },
      },
      required: ["name", "source"],
    },
  },
  {
    name: "list_sdks",
    description:
      "Return every indexed SDK (stdlib + user-authored + generated), with symbol counts.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "query_types",
    description:
      "FTS5 search over indexed symbol signatures (functions, types, interfaces, classes, consts). Useful when searching for a specific type-level API.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search text (FTS5 prefix)." },
        sdk: { type: "string", description: "Restrict to a single SDK." },
        kind: {
          type: "string",
          description: "Restrict to a single symbol kind.",
        },
        limit: { type: "number" },
      },
      required: ["pattern"],
    },
  },
];

// ───────────────────────────────────────────────────────── result shapers ──

function successResult(structured: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structured, null, 2),
      },
    ],
    structuredContent: structured as Record<string, unknown>,
  };
}

function errorResult(message: string, structured?: unknown): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: message }];
  if (structured !== undefined) {
    content.push({ type: "text", text: JSON.stringify(structured, null, 2) });
  }
  return { isError: true, content };
}

/**
 * A `RunResult` has both a structured body and a `logs` channel. We fold both
 * into the MCP content array — structured on top, logs below — and include
 * `structuredContent` for clients that understand it.
 */
function runResultToMcp(result: unknown): CallToolResult {
  const r = result as {
    success: boolean;
    logs?: { stdout?: string; stderr?: string };
    reason?: string;
    error?: string;
  };
  const content: CallToolResult["content"] = [
    { type: "text", text: JSON.stringify(result, null, 2) },
  ];
  if (r.logs?.stdout || r.logs?.stderr) {
    const logText =
      (r.logs.stdout ? `─ stdout ─\n${r.logs.stdout}` : "") +
      (r.logs.stderr ? `\n─ stderr ─\n${r.logs.stderr}` : "");
    content.push({ type: "text", text: logText });
  }
  return {
    isError: r.success === false,
    content,
    structuredContent: result as Record<string, unknown>,
  };
}
