/**
 * `code-mode doctor` — workspace health + self-healing.
 *
 * Full typecheck pass over every indexed script:
 *   - On diagnostics, flip `scripts.status = 'unusable'` with the first
 *     diagnostic message as `status_reason`. Clean scripts get reset to 'ok'
 *     so that a previously-broken-but-now-fixed script re-enters search.
 *
 * Reports (stdout default, or JSON via `--json`):
 *   - Broken scripts (count + paths).
 *   - Stale scripts (`last_run` older than `--stale-days`, default 30).
 *   - Low-success scripts (`success_rate < 0.5` and `runs >= 3`).
 *   - DB freshness mismatch (files newer on disk than their `indexed_at`).
 *
 * Exit code 1 if broken scripts exist (CI-friendly); `--no-fail` to override.
 */

import { existsSync, statSync } from "node:fs";
import type { Database } from "better-sqlite3";
import type { Project } from "ts-morph";
import { loadProject } from "../analysis/project.ts";
import { typecheckFile } from "../analysis/typecheck.ts";
import { migrate } from "../db/migrate.ts";
import { resolveWorkspacePaths } from "../index/reindex.ts";

export interface DoctorOptions {
  path?: string;
  json?: boolean;
  staleDays?: number | string;
  /** Commander `--no-fail` → `fail: false`. Defaults to true. */
  fail?: boolean;
  /** Test overrides — same injection story as reindex(). */
  db?: Database;
  project?: Project;
}

export interface DoctorBrokenEntry {
  path: string;
  name: string;
  reason: string;
}

export interface DoctorStaleEntry {
  path: string;
  name: string;
  lastRun: string | null;
  ageDays: number | null;
}

export interface DoctorLowSuccessEntry {
  path: string;
  name: string;
  runs: number;
  successRate: number;
}

export interface DoctorFreshnessEntry {
  path: string;
  name: string;
  indexedAt: string;
  mtime: string;
}

export interface DoctorReport {
  broken: DoctorBrokenEntry[];
  stale: DoctorStaleEntry[];
  lowSuccess: DoctorLowSuccessEntry[];
  freshness: DoctorFreshnessEntry[];
  scriptsChecked: number;
  staleDays: number;
}

interface ScriptHealthRow {
  path: string;
  name: string;
  status: string;
  status_reason: string | null;
  runs: number;
  last_run: string | null;
  success_rate: number | null;
  indexed_at: string;
}

const DEFAULT_STALE_DAYS = 30;
const LOW_SUCCESS_THRESHOLD = 0.5;
const LOW_SUCCESS_MIN_RUNS = 3;

/**
 * Core doctor routine. Returns a structured report and mutates the DB so
 * broken scripts are flagged `status='unusable'`.
 */
export async function runDoctor(
  workspaceDir: string,
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const ws = resolveWorkspacePaths(workspaceDir);
  const db = opts.db ?? (await openDb(ws.dbPath));
  migrate(db);

  const project = opts.project ?? loadProject(workspaceDir);
  const staleDays = normalizeStaleDays(opts.staleDays);

  const rows = db.prepare(
    `SELECT path, name, status, status_reason, runs, last_run, success_rate, indexed_at
       FROM scripts`,
  ).all() as ScriptHealthRow[];

  const broken: DoctorBrokenEntry[] = [];
  const stale: DoctorStaleEntry[] = [];
  const lowSuccess: DoctorLowSuccessEntry[] = [];
  const freshness: DoctorFreshnessEntry[] = [];

  const updateStatus = db.prepare(
    `UPDATE scripts SET status = $status, status_reason = $reason WHERE path = $path`,
  );

  for (const row of rows) {
    // Typecheck pass. A file missing on disk also counts as broken.
    let reason: string | null = null;
    if (!existsSync(row.path)) {
      reason = "source file missing on disk";
    } else {
      // Make sure ts-morph knows about the file (reindex may have loaded a subset).
      if (!project.getSourceFile(row.path)) {
        try {
          project.addSourceFileAtPath(row.path);
        } catch {
          // If we can't load it, count the load failure as the reason.
          reason = "source file could not be loaded";
        }
      }
      if (reason === null) {
        const diags = typecheckFile(project, row.path).filter(
          (d) => d.severity === "error",
        );
        if (diags.length > 0) reason = diags[0]!.message;
      }
    }

    if (reason !== null) {
      broken.push({ path: row.path, name: row.name, reason });
      updateStatus.run({ status: "unusable", reason: reason, path: row.path });
    } else if (row.status !== "ok") {
      // Recovery: previously broken scripts that now typecheck clean flip back.
      updateStatus.run({ status: "ok", reason: null, path: row.path });
    }

    // Stale detection — independent of typecheck health.
    const staleEntry = detectStale(row, staleDays);
    if (staleEntry) stale.push(staleEntry);

    // Low-success detection.
    if (
      row.runs >= LOW_SUCCESS_MIN_RUNS &&
      row.success_rate !== null &&
      row.success_rate < LOW_SUCCESS_THRESHOLD
    ) {
      lowSuccess.push({
        path: row.path,
        name: row.name,
        runs: row.runs,
        successRate: row.success_rate,
      });
    }

    // Freshness mismatch.
    const fresh = detectFreshness(row);
    if (fresh) freshness.push(fresh);
  }

  return {
    broken,
    stale,
    lowSuccess,
    freshness,
    scriptsChecked: rows.length,
    staleDays,
  };
}

/**
 * CLI entrypoint. Formats the report, prints it, then exits nonzero if any
 * broken scripts exist (unless `--no-fail`).
 */
export async function handler(opts: DoctorOptions): Promise<void> {
  const workspaceDir = opts.path ?? process.cwd();
  const report = await runDoctor(workspaceDir, opts);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  const shouldFail = opts.fail !== false;
  if (shouldFail && report.broken.length > 0) {
    process.exit(1);
  }
}

// ──────────────────────────────────────────────────────────────── helpers ──

function detectStale(
  row: ScriptHealthRow,
  staleDays: number,
): DoctorStaleEntry | null {
  if (row.last_run === null) {
    return {
      path: row.path,
      name: row.name,
      lastRun: null,
      ageDays: null,
    };
  }
  const parsed = Date.parse(row.last_run);
  if (Number.isNaN(parsed)) {
    return {
      path: row.path,
      name: row.name,
      lastRun: row.last_run,
      ageDays: null,
    };
  }
  const ageDays = (Date.now() - parsed) / (1000 * 60 * 60 * 24);
  if (ageDays >= staleDays) {
    return {
      path: row.path,
      name: row.name,
      lastRun: row.last_run,
      ageDays: Math.round(ageDays),
    };
  }
  return null;
}

function detectFreshness(row: ScriptHealthRow): DoctorFreshnessEntry | null {
  if (!existsSync(row.path)) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(row.path).mtimeMs;
  } catch {
    return null;
  }
  const indexedMs = Date.parse(row.indexed_at);
  if (Number.isNaN(indexedMs)) return null;
  // Allow a 1s cushion to cover filesystem mtime resolution differences.
  if (mtimeMs > indexedMs + 1000) {
    return {
      path: row.path,
      name: row.name,
      indexedAt: row.indexed_at,
      mtime: new Date(mtimeMs).toISOString(),
    };
  }
  return null;
}

function normalizeStaleDays(raw: number | string | undefined): number {
  if (raw === undefined) return DEFAULT_STALE_DAYS;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STALE_DAYS;
  return n;
}

function printReport(report: DoctorReport): void {
  console.log(
    `[code-mode doctor] scripts=${report.scriptsChecked} ` +
      `broken=${report.broken.length} stale=${report.stale.length} ` +
      `low-success=${report.lowSuccess.length} freshness=${report.freshness.length}`,
  );
  if (report.broken.length > 0) {
    console.log("\nBroken scripts:");
    for (const b of report.broken) {
      console.log(`  - ${b.name}  [${b.path}]`);
      console.log(`      ${b.reason}`);
    }
  }
  if (report.stale.length > 0) {
    console.log(`\nStale scripts (>= ${report.staleDays}d since last_run):`);
    for (const s of report.stale) {
      const age = s.ageDays === null ? "never run" : `${s.ageDays}d`;
      console.log(`  - ${s.name}  (${age})  [${s.path}]`);
    }
  }
  if (report.lowSuccess.length > 0) {
    console.log(
      `\nLow-success scripts (rate < ${LOW_SUCCESS_THRESHOLD}, runs >= ${LOW_SUCCESS_MIN_RUNS}):`,
    );
    for (const l of report.lowSuccess) {
      console.log(
        `  - ${l.name}  runs=${l.runs} success=${l.successRate.toFixed(2)}  [${l.path}]`,
      );
    }
  }
  if (report.freshness.length > 0) {
    console.log("\nFreshness mismatch (file newer than indexed_at):");
    for (const f of report.freshness) {
      console.log(
        `  - ${f.name}  indexed=${f.indexedAt}  mtime=${f.mtime}  [${f.path}]`,
      );
    }
  }
}

async function openDb(dbPath: string) {
  const { openDatabase } = await import("../db/open.ts");
  return openDatabase(dbPath);
}
