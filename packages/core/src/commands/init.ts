import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../db/open.ts";
import { reindex } from "../index/reindex.ts";
import { tsconfigJson } from "../templates/tsconfig.json.ts";
import { packageJson } from "../templates/package.json.ts";
import { filterTs } from "../templates/stdlib/filter.ts";
import { fuzzyMatchTs } from "../templates/stdlib/fuzzy-match.ts";
import { flattenTs } from "../templates/stdlib/flatten.ts";
import { tableTs } from "../templates/stdlib/table.ts";

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
 *   - sdks/stdlib/{filter,fuzzy-match,flatten,table}.ts
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
    { rel: "sdks/.generated/.keep", content: "" },
  ];

  for (const target of targets) {
    const abs = join(workspace, target.rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, target.content, "utf8");
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

  // Seed the FTS + symbols index so first-use of `search` / `list-sdks` /
  // `query-types` surfaces the scaffolded stdlib. Skip when we skipped
  // install — reindex needs ts-morph's type resolution, which needs
  // node_modules. The agent can still run `code-mode reindex` manually.
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
