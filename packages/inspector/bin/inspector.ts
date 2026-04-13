#!/usr/bin/env bun
/**
 * Inspector standalone entrypoint.
 *
 * Usage:
 *   bun run bin/inspector.ts [--port N] [--host 127.0.0.1] [--workspace /path] [--no-open]
 *
 * Parsed with a tiny inline argv scanner to avoid pulling commander into the
 * inspector package.
 */

import { startInspectorServer } from "../server/server.ts";

interface Argv {
  port: number;
  host: string;
  workspace: string;
  noOpen: boolean;
  userConfig?: string;
}

function parseArgs(argv: string[]): Argv {
  const out: Argv = {
    port: 3456,
    host: "127.0.0.1",
    workspace: process.cwd(),
    noOpen: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i] ?? "127.0.0.1";
    else if (a === "--workspace") out.workspace = argv[++i] ?? process.cwd();
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--user-config") out.userConfig = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const handle = await startInspectorServer({
    port: args.port,
    host: args.host,
    workspaceDir: args.workspace,
    userConfigPath: args.userConfig,
  });

  // eslint-disable-next-line no-console
  console.log(`[code-mode inspect] listening on ${handle.url}`);

  if (!args.noOpen) {
    openBrowser(handle.url);
  }

  const shutdown = async (): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log("\n[code-mode inspect] shutting down");
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive.
  await new Promise<never>(() => {});
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // best-effort
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[code-mode inspect] fatal:", err);
  process.exit(1);
});
