import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../db/open.ts";
import { reindex, resolveWorkspacePaths } from "../index/reindex.ts";
import { generateSdks } from "../sdk-gen/index.ts";
import { tsconfigJson } from "../templates/tsconfig.json.ts";
import { packageJson } from "../templates/package.json.ts";
import { filterTs } from "../templates/stdlib/filter.ts";
import { fuzzyMatchTs } from "../templates/stdlib/fuzzy-match.ts";
import { flattenTs } from "../templates/stdlib/flatten.ts";
import { tableTs } from "../templates/stdlib/table.ts";
import { fetchTs } from "../templates/stdlib/fetch.ts";
import { grepTs } from "../templates/stdlib/grep.ts";
import { globTs } from "../templates/stdlib/glob.ts";
import { configPath, defaultConfig, saveConfig } from "../workspace/config.ts";

export interface InitOptions {
  path?: string;
  force?: boolean;
  /**
   * Commander with `--no-install` sets `install: false`.
   * Defaults to `true` (run `bun install`).
   */
  install?: boolean;
}

interface WriteTarget {
  rel: string;
  content: string;
}

/**
 * Scaffold a `.code-mode/` workspace inside the target directory.
 *
 * Writes:
 *   - package.json           (workspace root)
 *   - tsconfig.json          (paths: @/* -> ./*)
 *   - scripts/.keep
 *   - sdks/.keep
 *   - sdks/stdlib/{filter,fuzzy-match,flatten,table,fetch,grep,glob}.ts
 *   - sdks/.generated/.keep
 *   - code-mode.db           (empty SQLite file, via better-sqlite3)
 *
 * Then, unless `--no-install` is passed, runs `bun install` inside the
 * workspace so that `@/*` path resolution has a `node_modules/` to
 * reference (bun-types, typescript).
 *
 * Exits nonzero (via `process.exit(1)`) if `.code-mode/` already exists
 * and `--force` was not passed.
 */
export async function handler(opts: InitOptions): Promise<void> {
  const targetRoot = resolve(opts.path ?? process.cwd());
  const workspace = join(targetRoot, ".code-mode");
  const shouldInstall = opts.install !== false;

  if (!existsSync(targetRoot)) {
    console.error(`[code-mode init] target directory does not exist: ${targetRoot}`);
    process.exit(1);
  }

  if (existsSync(workspace)) {
    if (!opts.force) {
      console.error(
        `[code-mode init] .code-mode/ already exists at ${workspace} — pass --force to overwrite.`,
      );
      process.exit(1);
    }
    rmSync(workspace, { recursive: true, force: true });
  }

  mkdirSync(workspace, { recursive: true });

  const targets: WriteTarget[] = [
    { rel: "package.json", content: packageJson() },
    { rel: "tsconfig.json", content: tsconfigJson() },
    { rel: "scripts/.keep", content: "" },
    { rel: "sdks/.keep", content: "" },
    { rel: "sdks/stdlib/filter.ts", content: filterTs() },
    { rel: "sdks/stdlib/fuzzy-match.ts", content: fuzzyMatchTs() },
    { rel: "sdks/stdlib/flatten.ts", content: flattenTs() },
    { rel: "sdks/stdlib/table.ts", content: tableTs() },
    { rel: "sdks/stdlib/fetch.ts", content: fetchTs() },
    { rel: "sdks/stdlib/grep.ts", content: grepTs() },
    { rel: "sdks/stdlib/glob.ts", content: globTs() },
    { rel: "sdks/.generated/.keep", content: "" },
  ];

  for (const target of targets) {
    const abs = join(workspace, target.rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, target.content, "utf8");
  }

  // Seed a default .code-mode/config.json unless one already exists
  // (respect user edits on re-init — `--force` above already rm'd the
  // workspace entirely, so that path will also land here writing a fresh
  // default).
  if (!existsSync(configPath(targetRoot))) {
    saveConfig(targetRoot, defaultConfig());
  }

  // Create an empty SQLite database file so the file header is valid.
  const dbPath = join(workspace, "code-mode.db");
  const db = openDatabase(dbPath);
  db.close();

  console.log(`[code-mode init] scaffolded workspace at ${workspace}`);

  if (shouldInstall) {
    const installer = pickInstaller();
    if (!installer) {
      console.error(
        `[code-mode init] neither 'bun' nor 'npm' found on PATH. ` +
          `The workspace was still scaffolded; install deps inside ${workspace} manually.`,
      );
      process.exit(1);
    }
    console.log(
      `[code-mode init] running '${installer.cmd} ${installer.args.join(" ")}' in ${workspace}…`,
    );
    const result = spawnSync(installer.cmd, installer.args, {
      cwd: workspace,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(
        `[code-mode init] '${installer.cmd} install' exited with status ${result.status ?? "unknown"}. ` +
          `The workspace was still scaffolded; re-run the install inside ${workspace} manually.`,
      );
      process.exit(result.status ?? 1);
    }
  } else {
    console.log(`[code-mode init] skipped dependency install (--no-install).`);
  }

  // Reindex is split into two gating tiers because they have different
  // dependency profiles:
  //   1. MCP SDK generation (`generateSdks`) — pure stdio introspection of
  //      registered MCP servers + codegen. No ts-morph, no node_modules
  //      needed. Always safe to run, even under --no-install.
  //   2. Symbol/script indexing (`reindex`) — walks the workspace and uses
  //      ts-morph's type resolution, which requires node_modules to exist.
  //      Skipped under --no-install; the agent can run `code-mode reindex`
  //      manually after `bun install`.
  // Going with option (a)-ish from the v0.3.2 spec: keep the existing
  // `reindex()` API (it's already disk-only) and just call `generateSdks()`
  // separately first. No new flag needed.

  const ws = resolveWorkspacePaths(targetRoot);
  let mcpSdkCount = 0;
  try {
    const sdkReport = await generateSdks({
      workspaceDir: ws.workspaceDir,
      sdksDir: ws.sdksDir,
      scriptsDir: ws.scriptsDir,
    });
    mcpSdkCount = sdkReport.emit.serverFiles.length;
    const skipped = sdkReport.emit.skipped.length;
    console.log(
      `[code-mode init] generated ${mcpSdkCount} MCP SDK(s) (${skipped} skipped).`,
    );
  } catch (err) {
    // Some MCP servers fail with auth errors (github, figma need OAuth).
    // Non-fatal — the agent can re-run reindex once auth is sorted.
    console.error(
      `[code-mode init] MCP SDK generation failed: ${(err as Error).message}. ` +
        `Re-run \`code-mode reindex\` inside ${workspace} to retry.`,
    );
  }

  if (shouldInstall) {
    try {
      const report = await reindex(targetRoot);
      console.log(
        `[code-mode init] indexed ${report.symbolsIndexed} symbols across ${report.sdks.length} sdk(s).`,
      );
    } catch (err) {
      console.error(
        `[code-mode init] reindex failed: ${(err as Error).message}. ` +
          `Re-run \`code-mode reindex\` inside ${workspace} to fix.`,
      );
    }
  } else {
    console.log(
      `[code-mode init] generated ${mcpSdkCount} MCP SDK(s). ` +
        `Run 'code-mode reindex' after 'bun install' to index symbols.`,
    );
  }

  console.log(`[code-mode init] done.`);
}

/**
 * Prefer `bun install` (matches our tooling defaults), fall back to `npm
 * install` so node-only users get a working workspace too. Returns null if
 * neither is available.
 */
function pickInstaller(): { cmd: string; args: string[] } | null {
  if (hasOnPath("bun")) return { cmd: "bun", args: ["install"] };
  if (hasOnPath("npm")) return { cmd: "npm", args: ["install", "--silent"] };
  return null;
}

function hasOnPath(binary: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [binary], {
    stdio: "ignore",
  });
  return probe.status === 0;
}
