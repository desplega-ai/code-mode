/**
 * Bun HTTP server for the code-mode inspector.
 *
 * Endpoints (all JSON unless noted):
 *   GET  /             — static HTML UI
 *   GET  /app.js       — static UI JS
 *   GET  /api/servers  — list configured MCP servers (from discoverMcpServers)
 *   GET  /api/tools/:server — list tools for one server (introspect)
 *   POST /api/invoke   — { server, tool, args } → invoke tool, return result
 *   GET  /api/generated/:server — contents of .code-mode/sdks/.generated/<server>.ts
 *
 * Binds to 127.0.0.1 by default. Callers may override via the `host` option
 * to expose on LAN (a warning is logged when host !== 127.0.0.1 && !== localhost).
 *
 * The server is deliberately dependency-light and uses Bun's built-in HTTP +
 * file serving.  No auth — localhost-only assumption.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverMcpServers, type McpServerSpec } from "../../core/src/sdk-gen/config.ts";
import { introspectServer } from "../../core/src/sdk-gen/introspect.ts";
import { invokeTool } from "./invoke.ts";
import { renderIndexHtml, INDEX_CLIENT_JS } from "./ui.ts";

export interface InspectorServerOptions {
  /** Workspace dir to read .mcp.json / .code-mode/ from. Defaults to cwd. */
  workspaceDir?: string;
  /** Port. 0 lets the OS pick. Default 3456. */
  port?: number;
  /** Host. Default 127.0.0.1. */
  host?: string;
  /** Override the user-level `~/.claude.json` lookup (tests). */
  userConfigPath?: string;
}

export interface InspectorServerHandle {
  url: string;
  port: number;
  host: string;
  stop: () => Promise<void>;
}

export async function startInspectorServer(
  opts: InspectorServerOptions = {},
): Promise<InspectorServerHandle> {
  const workspaceDir = resolve(opts.workspaceDir ?? process.cwd());
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3456;
  const userConfigPath = opts.userConfigPath;

  if (host !== "127.0.0.1" && host !== "localhost") {
    // eslint-disable-next-line no-console
    console.warn(
      `[code-mode inspect] binding to ${host} — inspector has NO AUTH; use at your own risk`,
    );
  }

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        return await route(req, url, workspaceDir, userConfigPath);
      } catch (err) {
        return jsonResponse({ ok: false, error: (err as Error).message }, 500);
      }
    },
  });

  const boundPort = server.port ?? port;
  const boundHost = server.hostname ?? host;

  return {
    url: `http://${boundHost}:${boundPort}`,
    port: boundPort,
    host: boundHost,
    stop: async () => {
      server.stop(true);
    },
  };
}

async function route(
  req: Request,
  url: URL,
  workspaceDir: string,
  userConfigPath?: string,
): Promise<Response> {
  const { pathname } = url;
  const method = req.method.toUpperCase();

  if (method === "GET" && pathname === "/") {
    return new Response(renderIndexHtml(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (method === "GET" && pathname === "/app.js") {
    return new Response(INDEX_CLIENT_JS, {
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }

  if (method === "GET" && pathname === "/api/servers") {
    return jsonResponse(handleListServers(workspaceDir, userConfigPath));
  }

  if (method === "GET" && pathname.startsWith("/api/tools/")) {
    const serverName = decodeURIComponent(pathname.slice("/api/tools/".length));
    return jsonResponse(await handleListTools(workspaceDir, serverName, userConfigPath));
  }

  if (method === "POST" && pathname === "/api/invoke") {
    const body = (await req.json().catch(() => null)) as
      | { server?: string; tool?: string; args?: unknown }
      | null;
    if (!body || typeof body.server !== "string" || typeof body.tool !== "string") {
      return jsonResponse(
        { ok: false, error: "missing required fields: { server, tool, args }" },
        400,
      );
    }
    return jsonResponse(
      await handleInvoke(workspaceDir, body.server, body.tool, body.args, userConfigPath),
    );
  }

  if (method === "GET" && pathname.startsWith("/api/generated/")) {
    const serverName = decodeURIComponent(pathname.slice("/api/generated/".length));
    return handleGenerated(workspaceDir, serverName);
  }

  return new Response("not found", { status: 404 });
}

function handleListServers(workspaceDir: string, userConfigPath?: string): {
  ok: true;
  servers: Array<{ name: string; transport: string; sourcePath: string }>;
  errors: Array<{ sourcePath: string; reason: string }>;
} {
  const { servers, errors } = discoverMcpServers({ workspaceDir, userConfigPath });
  return {
    ok: true,
    servers: servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      sourcePath: s.sourcePath,
    })),
    errors,
  };
}

async function handleListTools(
  workspaceDir: string,
  serverName: string,
  userConfigPath?: string,
): Promise<unknown> {
  const spec = findSpec(workspaceDir, serverName, userConfigPath);
  if (!spec) return { ok: false, error: `unknown server '${serverName}'` };
  const result = await introspectServer(spec, { timeoutMs: 15_000 });
  return {
    ok: result.ok,
    error: result.error,
    tools: result.tools,
  };
}

async function handleInvoke(
  workspaceDir: string,
  serverName: string,
  toolName: string,
  args: unknown,
  userConfigPath?: string,
): Promise<unknown> {
  const spec = findSpec(workspaceDir, serverName, userConfigPath);
  if (!spec) return { ok: false, error: `unknown server '${serverName}'` };
  return invokeTool(spec, toolName, args, { timeoutMs: 30_000 });
}

function handleGenerated(workspaceDir: string, serverName: string): Response {
  // Basic guard against traversal.
  if (serverName.includes("/") || serverName.includes("\\") || serverName.includes("..")) {
    return jsonResponse({ ok: false, error: "invalid server name" }, 400);
  }
  const path = join(workspaceDir, ".code-mode", "sdks", ".generated", `${serverName}.ts`);
  if (!existsSync(path)) {
    return jsonResponse(
      { ok: false, error: `no generated SDK for '${serverName}' at ${path}` },
      404,
    );
  }
  const contents = readFileSync(path, "utf8");
  return jsonResponse({ ok: true, path, contents });
}

function findSpec(
  workspaceDir: string,
  name: string,
  userConfigPath?: string,
): McpServerSpec | undefined {
  const { servers } = discoverMcpServers({ workspaceDir, userConfigPath });
  return servers.find((s) => s.name === name);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
