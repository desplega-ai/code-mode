/**
 * Lightweight MCP tool-invocation helper used by the inspector HTTP server.
 *
 * Kept separate from introspect.ts so we can reuse connection logic while
 * still calling `client.callTool(...)` — introspectServer() deliberately only
 * does initialize + tools/list and tears the connection down.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerSpec } from "../../core/src/sdk-gen/config.ts";

export interface InvokeResult {
  ok: boolean;
  /** Raw tool result from MCP when ok=true. */
  result?: unknown;
  error?: string;
}

export interface InvokeOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function invokeTool(
  spec: McpServerSpec,
  toolName: string,
  args: unknown,
  opts: InvokeOptions = {},
): Promise<InvokeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Client(
    { name: "code-mode-inspector", version: "0.0.0" },
    { capabilities: {} },
  );

  let transport: { close: () => Promise<void> };
  try {
    transport = buildTransport(spec);
  } catch (err) {
    return { ok: false, error: `transport-init: ${(err as Error).message}` };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    transport.close().catch(() => {});
  }, timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.connect(transport as any);
    const result = await client.callTool({
      name: toolName,
      arguments: (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
    });
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: timedOut
        ? `timeout after ${timeoutMs}ms`
        : `invoke-error: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
    try {
      await client.close();
    } catch {
      // best-effort
    }
    try {
      await transport.close();
    } catch {
      // best-effort
    }
  }
}

function buildTransport(spec: McpServerSpec): { close: () => Promise<void> } {
  if (spec.transport === "stdio") {
    if (!spec.command) throw new Error(`stdio spec ${spec.name} missing 'command'`);
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: mergeEnv(spec.env),
      stderr: "pipe",
    }) as unknown as { close: () => Promise<void> };
  }
  if (!spec.url) throw new Error(`http spec ${spec.name} missing 'url'`);
  return new StreamableHTTPClientTransport(new URL(spec.url)) as unknown as {
    close: () => Promise<void>;
  };
}

function mergeEnv(extra?: Record<string, string>): Record<string, string> {
  if (!extra) return process.env as Record<string, string>;
  return { ...(process.env as Record<string, string>), ...extra };
}
