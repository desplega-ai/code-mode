/**
 * MCP server configuration discovery.
 *
 * Priority order (first wins):
 *   1. Explicit path passed via `--mcp-config` on reindex.
 *   2. Project-local `./.mcp.json` under the workspace directory.
 *   3. User-level `~/.claude.json` under the `mcpServers` key.
 *
 * Each supported config file is a JSON document shaped roughly like:
 *   { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }
 * or, for HTTP/SSE transports:
 *   { "mcpServers": { "<name>": { "url": "https://..." } } }
 *
 * We deliberately keep this dumb — no schema validation beyond the minimum to
 * build an `McpServerSpec`. Invalid entries are dropped and reported back so
 * `doctor` can surface them.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, join } from "node:path";

export type McpTransport = "stdio" | "http";

export interface McpServerSpec {
  name: string;
  transport: McpTransport;
  /** stdio transport fields */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http transport fields */
  url?: string;
  /** Absolute path of the config file this spec came from (for diagnostics). */
  sourcePath: string;
}

export interface DiscoveredConfigs {
  servers: McpServerSpec[];
  /** Configs that exist but failed to parse/validate (name → reason). */
  errors: Array<{ sourcePath: string; reason: string }>;
  /** Absolute paths we actually read from, in precedence order. */
  sources: string[];
}

export interface DiscoverOptions {
  workspaceDir: string;
  /** Explicit `--mcp-config <path>` passed by the user. */
  explicitPath?: string;
  /** Override for `~/.claude.json` (tests). */
  userConfigPath?: string;
}

/**
 * Discover MCP servers for a workspace, honoring the documented precedence.
 */
export function discoverMcpServers(opts: DiscoverOptions): DiscoveredConfigs {
  const errors: Array<{ sourcePath: string; reason: string }> = [];
  const sources: string[] = [];
  const seenNames = new Set<string>();
  const servers: McpServerSpec[] = [];

  const candidates: Array<{ path: string; required: boolean }> = [];
  if (opts.explicitPath) {
    candidates.push({
      path: resolveAbs(opts.explicitPath, opts.workspaceDir),
      required: true,
    });
  }
  candidates.push({
    path: join(resolveAbs(opts.workspaceDir, process.cwd()), ".mcp.json"),
    required: false,
  });
  candidates.push({
    path: opts.userConfigPath ?? join(homedir(), ".claude.json"),
    required: false,
  });

  for (const c of candidates) {
    if (!existsSync(c.path)) {
      if (c.required) {
        errors.push({
          sourcePath: c.path,
          reason: `explicit --mcp-config path does not exist`,
        });
      }
      continue;
    }
    let raw: unknown;
    try {
      const text = readFileSync(c.path, "utf8");
      raw = JSON.parse(text);
    } catch (err) {
      errors.push({
        sourcePath: c.path,
        reason: `parse error: ${(err as Error).message}`,
      });
      continue;
    }
    const parsed = parseMcpServersBlock(raw, c.path);
    errors.push(...parsed.errors);
    sources.push(c.path);
    for (const spec of parsed.servers) {
      // First config wins per name.
      if (seenNames.has(spec.name)) continue;
      seenNames.add(spec.name);
      servers.push(spec);
    }
  }

  return { servers, errors, sources };
}

/**
 * Parse the `mcpServers` block out of an already-parsed JSON document.
 *
 * Exported for direct testing.
 */
export function parseMcpServersBlock(
  raw: unknown,
  sourcePath: string,
): { servers: McpServerSpec[]; errors: Array<{ sourcePath: string; reason: string }> } {
  const servers: McpServerSpec[] = [];
  const errors: Array<{ sourcePath: string; reason: string }> = [];
  if (!raw || typeof raw !== "object") {
    return { servers, errors };
  }
  const doc = raw as Record<string, unknown>;
  const block = doc.mcpServers;
  if (!block || typeof block !== "object") {
    return { servers, errors };
  }
  const entries = Object.entries(block as Record<string, unknown>);
  for (const [name, entryRaw] of entries) {
    if (!entryRaw || typeof entryRaw !== "object") {
      errors.push({
        sourcePath,
        reason: `mcpServers.${name}: expected object, got ${typeof entryRaw}`,
      });
      continue;
    }
    const entry = entryRaw as Record<string, unknown>;
    // Heuristic: `url` means HTTP; `command` means stdio.
    if (typeof entry.url === "string" && entry.url.trim() !== "") {
      servers.push({
        name,
        transport: "http",
        url: entry.url,
        sourcePath,
      });
      continue;
    }
    if (typeof entry.command === "string" && entry.command.trim() !== "") {
      const args = Array.isArray(entry.args)
        ? (entry.args as unknown[]).filter((v): v is string => typeof v === "string")
        : undefined;
      const env =
        entry.env && typeof entry.env === "object"
          ? pickStringMap(entry.env as Record<string, unknown>)
          : undefined;
      servers.push({
        name,
        transport: "stdio",
        command: entry.command,
        args,
        env,
        sourcePath,
      });
      continue;
    }
    errors.push({
      sourcePath,
      reason: `mcpServers.${name}: missing 'command' or 'url'`,
    });
  }
  return { servers, errors };
}

function resolveAbs(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

function pickStringMap(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
