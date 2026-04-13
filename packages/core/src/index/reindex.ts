/**
 * Reindex a `.code-mode/` workspace into its SQLite database.
 *
 * Sources on disk:
 *   - .code-mode/sdks/<sdk-name>/**\/*.ts   → `symbols` rows (scope derived from sdk-name)
 *   - .code-mode/scripts/*.ts               → `scripts` rows (flat; no nesting for MVP)
 *
 * Scope mapping (see plan Phase 4 + Phase 2 stdlib scaffolding):
 *   - sdks/stdlib/**       → scope = 'stdlib', sdk_name = 'stdlib'
 *   - sdks/.generated/<s>  → scope = 'generated', sdk_name = '.generated/<s>'
 *   - sdks/<other>/**      → scope = 'sdk', sdk_name = '<other>' (user-authored)
 *
 * Deletion pass: after upserts, any path present in the DB that no longer
 * exists on disk is removed. This keeps the index in lockstep with the
 * filesystem without requiring file watchers.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Database } from "better-sqlite3";
import type { Project } from "ts-morph";
import { loadProject, scopedExtract } from "../analysis/project.ts";
import {
  extractExportsFromSourceFile,
  type ExportInfo,
} from "../analysis/extract.ts";
import { migrate } from "../db/migrate.ts";
import type { SdkRow, SdkScope, SymbolInsert, SymbolScope } from "../db/schema.ts";
import {
  deleteScript,
  deleteSdk,
  deleteSymbolsByPath,
  insertSymbols,
  listScriptPaths,
  listSdkRows,
  listSymbolSourcePaths,
  upsertScript,
  upsertSdk,
  withTransaction,
} from "../db/repo.ts";

export interface ReindexOptions {
  /** When provided, only these absolute paths are re-processed (still runs deletion pass for those paths). */
  paths?: string[];
  /** Override the DB handle (defaults to `<workspace>/.code-mode/code-mode.db`). */
  db?: Database;
  /** Override the ts-morph Project (defaults to `loadProject(workspaceDir)`). */
  project?: Project;
}

export interface ReindexReport {
  scriptsIndexed: number;
  scriptsRemoved: number;
  symbolsIndexed: number;
  symbolsRemoved: number;
  sdks: SdkRow[];
  durationMs: number;
}

export interface WorkspacePaths {
  workspaceDir: string;
  codeModeDir: string;
  sdksDir: string;
  scriptsDir: string;
  dbPath: string;
}

export function resolveWorkspacePaths(workspaceDir: string): WorkspacePaths {
  const abs = resolve(workspaceDir);
  const codeModeDir = join(abs, ".code-mode");
  return {
    workspaceDir: abs,
    codeModeDir,
    sdksDir: join(codeModeDir, "sdks"),
    scriptsDir: join(codeModeDir, "scripts"),
    dbPath: join(codeModeDir, "code-mode.db"),
  };
}

export async function reindex(
  workspaceDir: string,
  opts: ReindexOptions = {},
): Promise<ReindexReport> {
  const started = Date.now();
  const ws = resolveWorkspacePaths(workspaceDir);

  // Lazy import of better-sqlite3 so this module is test-friendly under the
  // ts-morph path too.
  const db = opts.db ?? (await openDb(ws.dbPath));
  migrate(db);

  const project = opts.project ?? loadProject(workspaceDir);

  // ── discover files on disk ─────────────────────────────────────────────
  const sdkFiles = existsSync(ws.sdksDir) ? walkTsFiles(ws.sdksDir) : [];
  const scriptFiles = existsSync(ws.scriptsDir) ? listFlatTs(ws.scriptsDir) : [];

  const onDiskSymbolPaths = new Set(sdkFiles);
  const onDiskScriptPaths = new Set(scriptFiles);

  // Restrict to --paths if provided.
  const filterPaths = opts.paths ? new Set(opts.paths.map((p) => resolve(p))) : null;
  const targetSdkFiles = filterPaths
    ? sdkFiles.filter((f) => filterPaths.has(f))
    : sdkFiles;
  const targetScriptFiles = filterPaths
    ? scriptFiles.filter((f) => filterPaths.has(f))
    : scriptFiles;

  // Make sure ts-morph knows about the target files (init-scaffolded workspaces
  // are tsconfig-driven so this is usually a no-op; the add call is idempotent).
  for (const path of [...targetSdkFiles, ...targetScriptFiles]) {
    if (!project.getSourceFile(path)) {
      try {
        project.addSourceFileAtPath(path);
      } catch {
        // Non-fatal; typecheck layer surfaces as a diagnostic elsewhere.
      }
    }
  }

  let symbolsIndexed = 0;
  let scriptsIndexed = 0;
  const sdkSymbolCounts = new Map<string, { scope: SdkScope; dir: string; count: number }>();

  withTransaction(db, () => {
    // ── SDK files → symbols ──
    for (const absPath of targetSdkFiles) {
      const rel = relative(ws.sdksDir, absPath);
      const { symbolScope, sdkScope, sdkName, sdkDir } = classifySdkFile(
        ws.sdksDir,
        rel,
      );

      const exports = scopedExtract(project, () => {
        const sf = project.getSourceFile(absPath);
        return sf ? extractExportsFromSourceFile(sf) : [];
      });

      const inserts: SymbolInsert[] = exports.map((e) => ({
        source_path: absPath,
        kind: e.kind,
        name: e.name,
        signature: e.signature,
        jsdoc: stringifyJsdoc(e),
        scope: symbolScope,
        sdk_name: sdkName,
      }));

      deleteSymbolsByPath(db, absPath);
      insertSymbols(db, inserts);
      symbolsIndexed += inserts.length;

      const prev = sdkSymbolCounts.get(sdkName);
      if (prev) {
        prev.count += inserts.length;
      } else {
        sdkSymbolCounts.set(sdkName, {
          scope: sdkScope,
          dir: sdkDir,
          count: inserts.length,
        });
      }
    }

    // ── script files → scripts ──
    for (const absPath of targetScriptFiles) {
      const rel = relative(ws.scriptsDir, absPath);
      const name = rel.replace(/\.ts$/, "");
      const exports = scopedExtract(project, () => {
        const sf = project.getSourceFile(absPath);
        return sf ? extractExportsFromSourceFile(sf) : [];
      });
      const signatures = exports.map((e) => e.signature).join("\n");
      const description = deriveScriptDescription(exports);
      const tags = deriveScriptTags(exports);

      upsertScript(db, {
        path: absPath,
        name,
        description,
        tags,
        exportsJson: JSON.stringify(exports),
        signatures,
        indexedAt: new Date().toISOString(),
      });
      scriptsIndexed += 1;
    }

    // ── sdks table ──
    // When running a targeted reindex, still recompute counts for *touched*
    // sdks by counting existing rows for their source dir — this keeps the
    // sdks table consistent without requiring a full walk.
    for (const [sdkName, meta] of sdkSymbolCounts) {
      if (filterPaths) {
        // Targeted run: count all symbols still on disk for this sdk_name.
        const existing = db
          .prepare(`SELECT COUNT(*) as c FROM symbols WHERE sdk_name = ?`)
          .get(sdkName) as { c: number };
        meta.count = existing.c;
      }
      upsertSdk(db, {
        name: sdkName,
        scope: meta.scope,
        source_dir: meta.dir,
        symbol_count: meta.count,
        last_indexed: new Date().toISOString(),
      });
    }
  });

  // ── deletion pass (outside the upsert tx; cheap and independent) ──
  let symbolsRemoved = 0;
  let scriptsRemoved = 0;
  withTransaction(db, () => {
    if (!filterPaths) {
      // Full reindex: any DB-tracked path not on disk is stale.
      for (const p of listSymbolSourcePaths(db)) {
        if (!onDiskSymbolPaths.has(p)) {
          deleteSymbolsByPath(db, p);
          symbolsRemoved += 1;
        }
      }
      for (const p of listScriptPaths(db)) {
        if (!onDiskScriptPaths.has(p)) {
          deleteScript(db, p);
          scriptsRemoved += 1;
        }
      }
    } else {
      // Targeted: only remove among the filter set.
      for (const p of filterPaths) {
        if (!existsSync(p)) {
          deleteSymbolsByPath(db, p);
          deleteScript(db, p);
        }
      }
    }

    // Drop sdks rows whose source directory is empty or missing on disk.
    for (const row of listSdkRows(db)) {
      const stillHasSymbols = db
        .prepare(`SELECT COUNT(*) AS c FROM symbols WHERE sdk_name = ?`)
        .get(row.name) as { c: number };
      if (stillHasSymbols.c === 0) {
        deleteSdk(db, row.name);
      }
    }
  });

  const sdks = listSdkRows(db);
  const durationMs = Date.now() - started;
  return {
    scriptsIndexed,
    scriptsRemoved,
    symbolsIndexed,
    symbolsRemoved,
    sdks,
    durationMs,
  };
}

// ──────────────────────────────────────────────────────────────── helpers ──

/**
 * Recursively list every `.ts` file under `dir`. Skips files starting with `.`
 * (except dotdirs that may contain SDKs, so directory dots are allowed).
 */
export function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
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
      const full = join(cur, entry.name);
      if (entry.isDir) {
        if (entry.name === "node_modules") continue;
        stack.push(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.startsWith(".")) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * List `.ts` files directly inside `dir` (non-recursive).
 */
export function listFlatTs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.startsWith("."))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Given `<sdksDir>/<segment...>/<file>.ts`, figure out:
 *   - symbolScope: value for `symbols.scope`
 *   - sdkScope   : value for `sdks.scope`
 *   - sdkName    : value for `symbols.sdk_name` / `sdks.name`
 *   - sdkDir     : absolute path to the sdk's root directory
 */
export function classifySdkFile(
  sdksDir: string,
  relPath: string,
): { symbolScope: SymbolScope; sdkScope: SdkScope; sdkName: string; sdkDir: string } {
  const segments = relPath.split(sep);
  const top = segments[0] ?? "";
  if (top === "stdlib") {
    return {
      symbolScope: "stdlib",
      sdkScope: "stdlib",
      sdkName: "stdlib",
      sdkDir: join(sdksDir, "stdlib"),
    };
  }
  if (top === ".generated") {
    // `.generated/<sdkSlug>/...` — bucket by first nested segment when present.
    const nested = segments[1];
    if (nested) {
      const sdkName = `.generated/${nested}`;
      return {
        symbolScope: "generated",
        sdkScope: "generated",
        sdkName,
        sdkDir: join(sdksDir, ".generated", nested),
      };
    }
    return {
      symbolScope: "generated",
      sdkScope: "generated",
      sdkName: ".generated",
      sdkDir: join(sdksDir, ".generated"),
    };
  }
  return {
    symbolScope: "sdk",
    sdkScope: "user",
    sdkName: top,
    sdkDir: join(sdksDir, top),
  };
}

function stringifyJsdoc(e: ExportInfo): string | null {
  const parts: string[] = [];
  if (e.jsdocDescription) parts.push(e.jsdocDescription);
  if (e.jsdocTags) {
    for (const tag of e.jsdocTags) {
      parts.push(`@${tag.name} ${tag.value}`.trim());
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function deriveScriptDescription(exports: ExportInfo[]): string | null {
  // Prefer the `main` default-ish export's jsdoc; otherwise first export with
  // a description.
  for (const e of exports) {
    if (e.name === "main" && e.jsdocDescription) return e.jsdocDescription;
  }
  for (const e of exports) {
    if (e.jsdocDescription) return e.jsdocDescription;
  }
  return null;
}

function deriveScriptTags(exports: ExportInfo[]): string[] | null {
  for (const e of exports) {
    if (!e.jsdocTags) continue;
    for (const t of e.jsdocTags) {
      if (t.name === "tags") {
        return t.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
  }
  return null;
}

async function openDb(dbPath: string) {
  const { openDatabase } = await import("../db/open.ts");
  return openDatabase(dbPath);
}

// Re-exports for consumers that just want the reindex + utility surface.
export { statSync };
