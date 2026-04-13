/**
 * `code-mode run` — execute a saved or ad-hoc script.
 *
 * Resolution:
 *   - `run --inline <file>`  → ad-hoc; file outside `.code-mode/`.
 *   - `run --source -`       → read TS source from stdin, write to a tempfile.
 *   - `run <name>`           → `.code-mode/scripts/<name>.ts`.
 *
 * On success, increments runs / updates last_run / rolling-averages success_rate
 * in the DB for saved scripts.
 */

import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath, isAbsolute, join } from "node:path";
import { openDatabase } from "../db/open.ts";
import { execScript, type RunResult } from "../runner/exec.ts";
import { resolveWorkspacePaths } from "../index/reindex.ts";
import { migrate } from "../db/migrate.ts";
import { getScript } from "../db/repo.ts";
import { normalizeScriptSource } from "../analysis/normalize.ts";

export interface RunOptions {
  mode?: string; // positional "name" arg from Commander
  inline?: string;
  source?: boolean | string; // "-" indicates stdin
  args?: string;
  path?: string;
  timeout?: string;
  maxMemory?: string;
  maxCpu?: string;
  maxOutput?: string;
  /** Emit JSON to stdout. Default true. */
  json?: boolean;
  /**
   * Hook for tests — skip the real DB update, skip `process.exit(...)`,
   * and return the `RunResult` as a resolved promise.
   */
  _returnResult?: boolean;
}

export async function handler(opts: RunOptions): Promise<RunResult | void> {
  const workspaceDir = resolvePath(opts.path ?? process.cwd());
  const { entryAbs, cleanup } = await resolveEntry(opts, workspaceDir);

  const limits = {
    timeoutMs: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
    maxMemoryMb: opts.maxMemory ? parseInt(opts.maxMemory, 10) : undefined,
    maxCpuSec: opts.maxCpu ? parseInt(opts.maxCpu, 10) : undefined,
    maxOutputBytes: opts.maxOutput ? parseInt(opts.maxOutput, 10) : undefined,
  };

  let result: RunResult;
  try {
    result = await execScript({
      workspaceDir,
      entry: entryAbs,
      argsJson: opts.args ?? "null",
      limits,
    });
  } finally {
    cleanup?.();
  }

  // Update usage counters for saved scripts (only on success).
  if (result.success && isSavedScript(entryAbs, workspaceDir)) {
    try {
      updateUsageCounter(workspaceDir, entryAbs, true);
    } catch (e) {
      // Don't fail the run because of counter bookkeeping.
      process.stderr.write(
        `[code-mode run] failed to update usage counter: ${(e as Error).message}\n`,
      );
    }
  } else if (!result.success && isSavedScript(entryAbs, workspaceDir)) {
    try {
      updateUsageCounter(workspaceDir, entryAbs, false);
    } catch {
      // ignore
    }
  }

  if (opts._returnResult) {
    return result;
  }

  // Emit JSON to stdout for CLI consumers.
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.success) {
    process.exitCode = 1;
  }
}

// ─────────────────────────────────────────────────────────────── resolvers ──

async function resolveEntry(
  opts: RunOptions,
  workspaceDir: string,
): Promise<{ entryAbs: string; cleanup?: () => void }> {
  if (opts.inline) {
    const abs = resolvePath(opts.inline);
    if (!existsSync(abs)) {
      throw new Error(`--inline file not found: ${abs}`);
    }
    return { entryAbs: abs };
  }

  if (opts.source === "-" || opts.source === true) {
    const src = await readStdin();
    const normalized = normalizeScriptSource(src);
    const tmp = mkdtempSync(join(tmpdir(), "code-mode-run-"));
    const file = join(tmp, "inline.ts");
    writeFileSync(file, normalized.source, "utf8");
    return {
      entryAbs: file,
      cleanup: () => {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {
          // ignore
        }
      },
    };
  }

  if (!opts.mode) {
    throw new Error(
      "code-mode run: missing script name. Pass a saved name, --inline <file>, or --source -",
    );
  }

  const ws = resolveWorkspacePaths(workspaceDir);
  // Allow either "foo" or "foo.ts"
  const named = opts.mode.endsWith(".ts") ? opts.mode : `${opts.mode}.ts`;
  const abs = isAbsolute(named) ? named : join(ws.scriptsDir, named);
  if (!existsSync(abs)) {
    throw new Error(`saved script not found: ${abs}`);
  }
  return { entryAbs: abs };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ───────────────────────────────────────────────────────────────── db hook ──

function isSavedScript(entryAbs: string, workspaceDir: string): boolean {
  const ws = resolveWorkspacePaths(workspaceDir);
  return entryAbs.startsWith(ws.scriptsDir);
}

/**
 * Increment `runs`, stamp `last_run`, and rolling-average `success_rate`.
 *
 * Rolling average is computed as `((old_rate * old_runs) + outcome) / (old_runs + 1)`.
 * If `success_rate` was NULL (never run before), we seed it with the current
 * outcome (1.0 or 0.0).
 */
export function updateUsageCounter(
  workspaceDir: string,
  entryAbs: string,
  success: boolean,
): void {
  const ws = resolveWorkspacePaths(workspaceDir);
  if (!existsSync(ws.dbPath)) return;
  const db = openDatabase(ws.dbPath);
  try {
    migrate(db);
    const row = getScript(db, entryAbs);
    if (!row) return; // Not yet indexed; ignore.
    const oldRuns = row.runs ?? 0;
    const oldRate = row.success_rate;
    const outcome = success ? 1 : 0;
    const newRuns = oldRuns + 1;
    const newRate =
      oldRate == null
        ? outcome
        : (oldRate * oldRuns + outcome) / newRuns;
    db.prepare(
      `UPDATE scripts SET runs = ?, last_run = ?, success_rate = ? WHERE path = ?`,
    ).run(newRuns, new Date().toISOString(), newRate, entryAbs);
  } finally {
    db.close();
  }
}
