/**
 * `code-mode inspect` — spawn the inspector server from the sibling workspace.
 *
 * The inspector lives in `@code-mode/inspector` (packages/inspector) — we never
 * import React/Vite/anything from that package into the core bundle so that
 * `code-mode --help` stays lean. Instead we spawn `bun run` on the inspector's
 * bin entry as a subprocess and forward stdout/stderr.
 *
 * Resolution order for the inspector entry script:
 *   1. `CODE_MODE_INSPECTOR_BIN` env var (tests, forks).
 *   2. `packages/inspector/bin/inspector.ts` relative to this file (monorepo dev).
 *   3. `bunx @code-mode/inspector code-mode-inspect` fallback (installed-global).
 */

import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface InspectOptions {
  port?: string | number;
  host?: string;
  open?: boolean;
  path?: string;
  userConfig?: string;
}

export async function handler(opts: InspectOptions): Promise<void> {
  const workspaceDir = resolve(opts.path ?? process.cwd());
  const port = String(opts.port ?? 3456);
  const host = opts.host ?? "127.0.0.1";
  const open = opts.open !== false;

  const entry = resolveInspectorEntry();

  const args: string[] = [];
  let cmd: string[];
  if (entry.kind === "local") {
    cmd = ["bun", "run", entry.path, "--port", port, "--host", host, "--workspace", workspaceDir];
  } else {
    cmd = [
      "bunx",
      "-p",
      "@code-mode/inspector",
      "code-mode-inspect",
      "--port",
      port,
      "--host",
      host,
      "--workspace",
      workspaceDir,
    ];
  }
  if (!open) cmd.push("--no-open");
  if (opts.userConfig) cmd.push("--user-config", opts.userConfig);

  // eslint-disable-next-line no-console
  console.log(`[code-mode inspect] launching inspector (${entry.kind})`);

  const proc = Bun.spawn(cmd.concat(args), {
    stdio: ["inherit", "inherit", "inherit"],
  });

  // Forward signals.
  const killAndExit = async (signal: NodeJS.Signals): Promise<void> => {
    try {
      proc.kill(signal);
    } catch {
      // ignore
    }
    const exitCode = await proc.exited;
    process.exit(exitCode ?? 0);
  };
  process.on("SIGINT", () => void killAndExit("SIGINT"));
  process.on("SIGTERM", () => void killAndExit("SIGTERM"));

  const exitCode = await proc.exited;
  process.exit(exitCode ?? 0);
}

function resolveInspectorEntry():
  | { kind: "local"; path: string }
  | { kind: "bunx"; path: null } {
  const envBin = process.env.CODE_MODE_INSPECTOR_BIN;
  if (envBin && existsSync(envBin)) return { kind: "local", path: envBin };

  // packages/core/src/commands/inspect.ts → ../../../inspector/bin/inspector.ts
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "..", "..", "..", "inspector", "bin", "inspector.ts");
  if (existsSync(candidate)) return { kind: "local", path: candidate };

  // Alternative: when installed, the inspector lives next to core under
  // node_modules/@code-mode/inspector/bin/inspector.ts.
  const installed = resolve(here, "..", "..", "..", "..", "@code-mode", "inspector", "bin", "inspector.ts");
  if (existsSync(installed)) return { kind: "local", path: installed };

  return { kind: "bunx", path: null };
}

// For tests: expose resolution without spawning.
export function _resolveInspectorEntry(): ReturnType<typeof resolveInspectorEntry> {
  return resolveInspectorEntry();
}

// Suppress unused import for join until needed.
void join;
