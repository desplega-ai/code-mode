/**
 * sdk-gen entry point. Composes:
 *   discover → introspect → emit
 * and returns a structured report the reindex pipeline can log + surface in
 * `doctor`.
 */

import { discoverMcpServers, type McpServerSpec } from "./config.ts";
import { introspectAll, type IntrospectResult } from "./introspect.ts";
import { emitGeneratedSdks, type EmitReport, type EmitOptions } from "./emit.ts";

export interface SdkGenOptions {
  workspaceDir: string;
  /** Absolute path to `<workspace>/.code-mode/sdks`. */
  sdksDir: string;
  /**
   * Absolute path to `<workspace>/.code-mode/scripts`. Required to emit
   * starter templates when a server's script folder is empty.
   */
  scriptsDir?: string;
  /** Opt out of starter templates. Defaults to on when `scriptsDir` is set. */
  templates?: boolean;
  /** Explicit `--mcp-config <path>` passed by the user. */
  mcpConfigPath?: string;
  /** Test override: ~/.claude.json path. */
  userConfigPath?: string;
  /** Test override: pre-discovered specs (skips config discovery). */
  specsOverride?: McpServerSpec[];
  /** Test override: pre-computed introspect results (skips network + spawn). */
  introspectOverride?: IntrospectResult[];
  /** Per-server wall-clock timeout during introspect. */
  timeoutMs?: number;
  /** Pinned clock for deterministic codegen output. */
  now?: () => Date;
}

export interface SdkGenReport {
  servers: IntrospectResult[];
  emit: EmitReport;
  discoveryErrors: Array<{ sourcePath: string; reason: string }>;
  sources: string[];
}

export async function generateSdks(opts: SdkGenOptions): Promise<SdkGenReport> {
  let specs: McpServerSpec[];
  let discoveryErrors: Array<{ sourcePath: string; reason: string }> = [];
  let sources: string[] = [];

  if (opts.specsOverride) {
    specs = opts.specsOverride;
  } else {
    const disc = discoverMcpServers({
      workspaceDir: opts.workspaceDir,
      explicitPath: opts.mcpConfigPath,
      userConfigPath: opts.userConfigPath,
    });
    specs = disc.servers;
    discoveryErrors = disc.errors;
    sources = disc.sources;
  }

  const results =
    opts.introspectOverride ??
    (await introspectAll(specs, { timeoutMs: opts.timeoutMs }));

  const emitOpts: EmitOptions = {
    sdksDir: opts.sdksDir,
    scriptsDir: opts.scriptsDir,
    templates: opts.templates,
    now: opts.now,
  };
  const emit = await emitGeneratedSdks(results, emitOpts);

  return { servers: results, emit, discoveryErrors, sources };
}

export { discoverMcpServers } from "./config.ts";
export type { McpServerSpec } from "./config.ts";
export { introspectServer, introspectAll } from "./introspect.ts";
export type { IntrospectResult, IntrospectedTool } from "./introspect.ts";
export { emitGeneratedSdks, listGeneratedFiles } from "./emit.ts";
export type { EmitReport } from "./emit.ts";
export { generateToolCode } from "./codegen.ts";
