/**
 * Assemble + write the `.generated/` SDK directory for a workspace.
 *
 * Shape:
 *   .code-mode/sdks/.generated/
 *     _client.ts        — shared runtime invoker (one per workspace)
 *     <server>.ts       — one per server, imports `callTool` from _client
 *     _servers.json     — lightweight registry the client reads at runtime
 *                         to know how to spawn each server.
 *
 * Idempotency: we wipe `.generated/` before re-emitting, and file bodies are
 * deterministic modulo a timestamp header — tests pin both by passing a
 * stable `now` injection.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { McpServerSpec } from "./config.ts";
import type { IntrospectResult, IntrospectedTool } from "./introspect.ts";
import { generateToolCode, type CodegenOptions, type ToolCodegen } from "./codegen.ts";

export interface EmitOptions extends CodegenOptions {
  /** Absolute path to `<workspace>/.code-mode/sdks`. */
  sdksDir: string;
  /**
   * Optional absolute path to `<workspace>/.code-mode/scripts`. If provided
   * and `templates !== false`, we drop a starter `example.ts` under
   * `<scriptsDir>/<server>/` for every server whose folder is empty.
   */
  scriptsDir?: string;
  /** Opt out of template emission (defaults to on when scriptsDir is set). */
  templates?: boolean;
  /** Pinned timestamp for deterministic output. Defaults to now. */
  now?: () => Date;
}

export interface EmitReport {
  generatedDir: string;
  clientPath: string;
  serverFiles: Array<{ server: string; path: string; toolCount: number }>;
  skipped: Array<{ server: string; reason: string }>;
  /** Starter scripts created this run (only populated when templates ran). */
  templatesEmitted: Array<{ server: string; path: string }>;
}

export async function emitGeneratedSdks(
  results: IntrospectResult[],
  opts: EmitOptions,
): Promise<EmitReport> {
  const nowFn = opts.now ?? (() => new Date());
  const generatedDir = join(opts.sdksDir, ".generated");

  // Wipe + recreate the `.generated/` directory. Derived state, so a clean
  // rebuild is cheaper than reasoning about partial cleanups.
  if (existsSync(generatedDir)) {
    rmSync(generatedDir, { recursive: true, force: true });
  }
  mkdirSync(generatedDir, { recursive: true });

  const serverFiles: EmitReport["serverFiles"] = [];
  const skipped: EmitReport["skipped"] = [];

  // Write one module per successfully-introspected server.
  const registry: Record<string, RegistryEntry> = {};
  const successful: Array<{ server: string; slug: string; tools: IntrospectedTool[]; sdkPath: string }> = [];
  for (const result of results) {
    if (!result.ok) {
      skipped.push({ server: result.spec.name, reason: result.error ?? "unknown" });
      continue;
    }
    if (result.tools.length === 0) {
      skipped.push({ server: result.spec.name, reason: "no tools/list returned" });
      continue;
    }
    const slug = toSlug(result.spec.name);
    const codegen = generateToolCode(result.tools, result.spec.name, opts);
    const body = assembleServerModule(result.spec.name, codegen, nowFn().toISOString());
    const outPath = join(generatedDir, `${slug}.ts`);
    writeFileSync(outPath, body);
    serverFiles.push({
      server: result.spec.name,
      path: outPath,
      toolCount: codegen.length,
    });
    registry[result.spec.name] = specToRegistry(result.spec);
    successful.push({ server: result.spec.name, slug, tools: result.tools, sdkPath: outPath });
  }

  // Shared client + registry — always written, even if no servers succeeded,
  // so downstream code can `import { callTool } from "./_client"` safely.
  const clientPath = join(generatedDir, "_client.ts");
  writeFileSync(clientPath, CLIENT_RUNTIME_SOURCE);
  writeFileSync(join(generatedDir, "_servers.json"), JSON.stringify(registry, null, 2));

  // Starter templates: one example.ts per server whose scripts dir is empty.
  // Off unless the caller gave us a scriptsDir (keeps the `emit()` fn usable
  // without implying filesystem side effects outside `.generated/`).
  const templatesEmitted: EmitReport["templatesEmitted"] = [];
  const wantTemplates = opts.templates !== false && opts.scriptsDir !== undefined;
  if (wantTemplates && opts.scriptsDir) {
    for (const s of successful) {
      const serverScriptsDir = join(opts.scriptsDir, s.slug);
      if (hasAnyTsFile(serverScriptsDir)) continue;
      mkdirSync(serverScriptsDir, { recursive: true });
      const examplePath = join(serverScriptsDir, "example.ts");
      const firstTool = s.tools[0]!;
      const body = assembleStarterTemplate({
        serverName: s.server,
        sdkPath: s.sdkPath,
        scriptPath: examplePath,
        tool: firstTool,
      });
      writeFileSync(examplePath, body);
      templatesEmitted.push({ server: s.server, path: examplePath });
    }
  }

  return { generatedDir, clientPath, serverFiles, skipped, templatesEmitted };
}

/**
 * True when `dir` exists and has at least one `.ts` file (recursively). Used
 * to decide whether to emit a starter template — we never clobber an existing
 * scripts directory.
 */
function hasAnyTsFile(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: { name: string; isDir: boolean }[] = [];
    try {
      entries = readdirSync(cur, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
      }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDir) {
        stack.push(join(cur, entry.name));
      } else if (entry.name.endsWith(".ts")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build a starter script body. We import the first tool wrapper by its
 * camelCased name and call it with placeholder args — the agent can fill in
 * real values, but the file typechecks today as long as the generated SDK
 * module compiles.
 */
function assembleStarterTemplate(args: {
  serverName: string;
  sdkPath: string;
  scriptPath: string;
  tool: IntrospectedTool;
}): string {
  const toolFnName = toCamelCase(args.tool.name);
  const argsTypeName = `${toPascalCase(args.tool.name)}Args`;
  const placeholder = placeholderArgsLiteral(args.tool.inputSchema);
  // Relative import path from the script to the generated SDK module.
  let importRel = relative(dirname(args.scriptPath), args.sdkPath).replace(/\\/g, "/");
  if (!importRel.startsWith(".")) importRel = `./${importRel}`;

  return `/**
 * Starter template for MCP server "${args.serverName}".
 *
 * Generated by code-mode — safe to edit. Delete this file if you don't need
 * the example; it won't be regenerated as long as this directory has any
 * \`.ts\` file in it.
 *
 * @description Invoke ${args.serverName}.${args.tool.name} with placeholder args.
 * @tags generated, example
 */
import { ${toolFnName}, type ${argsTypeName} } from "${importRel}";

export default async function main(_input: unknown): Promise<unknown> {
  const args: ${argsTypeName} = ${placeholder};
  const result = await ${toolFnName}(args);
  return result;
}
`;
}

function toCamelCase(name: string): string {
  const parts = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return "tool";
  const head = parts[0]!.toLowerCase();
  const tail = parts.slice(1).map(
    (p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase(),
  );
  return head + tail.join("");
}

function toPascalCase(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "Tool";
  return parts
    .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase())
    .join("");
}

/**
 * Produce a JSON-ish placeholder for a tool's first call. For object schemas
 * with a `required` list, we emit `{}` with a TODO comment for each required
 * prop — `as` cast keeps things typecheck-clean even for partial fills. For
 * anything exotic we fall back to `{}` with a cast.
 */
function placeholderArgsLiteral(inputSchema: unknown): string {
  if (!inputSchema || typeof inputSchema !== "object") {
    return `{} as ${"never"}`;
  }
  const schema = inputSchema as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  if (required.length === 0 && Object.keys(props).length === 0) {
    return "{}";
  }
  const lines: string[] = ["{"];
  for (const key of required) {
    const propSchema = props[key] as Record<string, unknown> | undefined;
    const val = samplePropValue(propSchema);
    lines.push(`    ${JSON.stringify(key)}: ${val}, // TODO: fill in`);
  }
  if (required.length === 0) {
    // Only optional props; still emit an empty object so code compiles.
    return "{}";
  }
  lines.push("  }");
  return lines.join("\n  ");
}

function samplePropValue(prop: Record<string, unknown> | undefined): string {
  if (!prop) return `"" as unknown as never`;
  const t = prop.type;
  if (t === "string") return `""`;
  if (t === "number" || t === "integer") return `0`;
  if (t === "boolean") return `false`;
  if (t === "array") return `[]`;
  if (t === "object") return `{}`;
  return `null as unknown as never`;
}

interface RegistryEntry {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

function specToRegistry(spec: McpServerSpec): RegistryEntry {
  if (spec.transport === "stdio") {
    return {
      transport: "stdio",
      command: spec.command,
      args: spec.args,
      env: spec.env,
    };
  }
  return { transport: "http", url: spec.url };
}

/**
 * Emit a single server module. Layout:
 *   1. File-level JSDoc header — who generated it, when, from which server.
 *   2. Import of `callTool` from the shared runtime.
 *   3. Per-tool: args interface + result interface + async wrapper.
 */
function assembleServerModule(
  serverName: string,
  codegen: ToolCodegen[],
  generatedAt: string,
): string {
  const header =
    `/**\n` +
    ` * @generated by code-mode sdk-gen from MCP server "${serverName}" at ${generatedAt}.\n` +
    ` * DO NOT EDIT — this file is overwritten on every reindex.\n` +
    ` */\n`;

  const imports = `import { callTool } from "./_client.ts";\n`;

  const sections = codegen.map(
    (c) => `${c.inputDecl}\n\n${c.outputDecl}\n\n${c.fnDecl}`,
  );

  return `${header}${imports}\n${sections.join("\n\n")}\n`;
}

/**
 * Normalize a server name into a safe TS module filename. MCP names in the
 * wild include dashes, underscores, and occasionally slashes (for scoped
 * packages). We keep dashes and underscores, drop everything else.
 */
export function toSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9_\-]/g, "_");
}

/**
 * Shared runtime helper. Kept as an embedded string so tests can assert on
 * byte-for-byte stability without reading an extra file from disk, and so we
 * don't ship a separate `.ts` asset to copy at emit time.
 *
 * The helper uses lazy imports to keep the emitted SDKs loadable even when the
 * script being typechecked doesn't actually invoke a tool call.
 */
const CLIENT_RUNTIME_SOURCE = `/**
 * @generated by code-mode sdk-gen — shared runtime invoker.
 * Spawns the relevant MCP server on demand, runs one tool call, returns the
 * parsed result. Cached per-process so repeated calls reuse the same
 * transport.
 *
 * DO NOT EDIT — overwritten on every reindex.
 */

import serversJson from "./_servers.json" with { type: "json" };

interface RegistryEntry {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

const registry = serversJson as unknown as Record<string, RegistryEntry>;

interface ClientLike {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

const cache = new Map<string, Promise<ClientLike>>();

async function getClient(server: string): Promise<ClientLike> {
  const existing = cache.get(server);
  if (existing) return existing;
  const entry = registry[server];
  if (!entry) throw new Error(\`[code-mode] unknown MCP server: \${server}\`);
  const p = (async (): Promise<ClientLike> => {
    const [{ Client }, stdio, http] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ]);
    const client = new Client(
      { name: "code-mode-runtime", version: "0.0.0" },
      { capabilities: {} },
    );
    let transport: unknown;
    if (entry.transport === "stdio") {
      if (!entry.command) throw new Error(\`[code-mode] stdio server \${server} missing command\`);
      transport = new stdio.StdioClientTransport({
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env ? { ...(process.env as Record<string, string>), ...entry.env } : undefined,
        stderr: "inherit",
      });
    } else {
      if (!entry.url) throw new Error(\`[code-mode] http server \${server} missing url\`);
      transport = new http.StreamableHTTPClientTransport(new URL(entry.url));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).connect(transport);
    return client as unknown as ClientLike;
  })();
  cache.set(server, p);
  return p;
}

export async function callTool<T = unknown>(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<T> {
  const client = await getClient(server);
  const result = await client.callTool({ name: tool, arguments: args });
  return (result as { structuredContent?: unknown }).structuredContent as T ??
    (result as T);
}

export async function closeAll(): Promise<void> {
  const clients = Array.from(cache.values());
  cache.clear();
  await Promise.allSettled(
    clients.map(async (p) => {
      try {
        const c = await p;
        await c.close();
      } catch {
        /* best-effort */
      }
    }),
  );
}
`;

/**
 * Exported for tests: list every file currently under `.generated/`, so
 * idempotency tests can snapshot the full output directory.
 */
export function listGeneratedFiles(sdksDir: string): string[] {
  const generatedDir = join(sdksDir, ".generated");
  if (!existsSync(generatedDir)) return [];
  const out: string[] = [];
  const stack: string[] = [generatedDir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out.sort();
}
