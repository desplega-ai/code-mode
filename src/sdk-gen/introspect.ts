/**
 * Connect to an MCP server described by an `McpServerSpec`, run
 * `initialize` + `tools/list`, and return the collected tool metadata.
 *
 * Failures are returned as structured errors — they never throw out of this
 * module. The caller (reindex pipeline) decides whether to log, surface via
 * `doctor`, etc.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerSpec } from "./config.ts";

export interface IntrospectedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface IntrospectResult {
  spec: McpServerSpec;
  ok: boolean;
  tools: IntrospectedTool[];
  error?: string;
}

export interface IntrospectOptions {
  /** Wall-clock timeout for the entire introspect (init + list). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Drive one server through the initialize/tools-list flow.
 *
 * Guarantees:
 *   - Always returns an `IntrospectResult`, even on failure.
 *   - Always closes the transport (spawned process on stdio, keepalive on http)
 *     before returning.
 *   - Respects `timeoutMs` by racing against a timer that triggers a `close()`
 *     on the transport.
 */
export async function introspectServer(
  spec: McpServerSpec,
  opts: IntrospectOptions = {},
): Promise<IntrospectResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Client(
    { name: "code-mode-sdk-gen", version: "0.0.0" },
    { capabilities: {} },
  );

  // Build the transport. StreamableHTTPClientTransport is used for both SSE
  // and streaming HTTP MCP servers in the 1.x SDK; SSE path is still accepted.
  let transport: { close: () => Promise<void> };
  try {
    transport = buildTransport(spec);
  } catch (err) {
    return {
      spec,
      ok: false,
      tools: [],
      error: `transport-init: ${(err as Error).message}`,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Fire-and-forget close; the awaiting promises will reject shortly.
    transport.close().catch(() => {});
  }, timeoutMs).unref?.();
  // Some runtimes return a Timer vs. NodeJS.Timeout; `.unref?.()` keeps us
  // tolerant.

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.connect(transport as any);
    const resp = await client.listTools();
    const tools: IntrospectedTool[] = (resp.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    }));
    return { spec, ok: true, tools };
  } catch (err) {
    return {
      spec,
      ok: false,
      tools: [],
      error: timedOut
        ? `timeout after ${timeoutMs}ms`
        : `introspect-error: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
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

/**
 * Introspect a batch of servers sequentially. Keeping this sequential avoids
 * blowing the file-descriptor / subprocess budget when users have ~20 MCPs in
 * `~/.claude.json`.
 */
export async function introspectAll(
  specs: McpServerSpec[],
  opts: IntrospectOptions = {},
): Promise<IntrospectResult[]> {
  const out: IntrospectResult[] = [];
  for (const spec of specs) {
    out.push(await introspectServer(spec, opts));
  }
  return out;
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
  // getDefaultEnvironment is ideally used here, but we want spec.env to win
  // and also to allow tests to pass small env overrides. The SDK stdio
  // transport already calls getDefaultEnvironment() internally when `env` is
  // undefined; we only pass through a filled map when the user supplied one.
  if (!extra) return process.env as Record<string, string>;
  return { ...(process.env as Record<string, string>), ...extra };
}
