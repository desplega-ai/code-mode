/**
 * `code-mode gc` — soft cleanup for duplicates + stale scripts.
 *
 * Two detection passes:
 *   1. Duplicate symbols: group by normalized signature. Two signatures are
 *      considered equivalent when whitespace is collapsed and union member
 *      tokens are alphabetized. The agent gets a list of candidates to merge;
 *      we never auto-delete.
 *   2. Stale scripts: never-run (or last_run older than `--stale-days`, default 30)
 *      AND no incoming static imports from other indexed scripts/SDKs.
 *
 * Default run is dry-run; `--apply` moves flagged stale scripts into
 * `.code-mode/.trash/<timestamp>/` — we never `rm -rf`, so recovery is a
 * directory rename away. Duplicate detection is always read-only.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { migrate } from "../db/migrate.ts";
import { resolveWorkspacePaths } from "../index/reindex.ts";

export interface GcOptions {
  path?: string;
  json?: boolean;
  staleDays?: number | string;
  /** Commander `--apply` → `apply: true`. Defaults to false (dry-run). */
  apply?: boolean;
  /** Test override — inject a DB so tests don't need the fs layout. */
  db?: Database;
  /** Test override — pinned clock for deterministic trash path. */
  now?: () => Date;
}

export interface DuplicateGroup {
  normalizedSignature: string;
  members: Array<{
    name: string;
    kind: string;
    signature: string;
    sourcePath: string;
    sdkName: string | null;
  }>;
}

export interface StaleScriptEntry {
  path: string;
  name: string;
  lastRun: string | null;
  ageDays: number | null;
  movedTo?: string;
}

export interface GcReport {
  duplicates: DuplicateGroup[];
  stale: StaleScriptEntry[];
  apply: boolean;
  trashDir: string | null;
  staleDays: number;
}

interface SymbolRowLite {
  id: number;
  source_path: string;
  kind: string;
  name: string;
  signature: string;
  sdk_name: string | null;
}

interface ScriptRowLite {
  path: string;
  name: string;
  runs: number;
  last_run: string | null;
}

const DEFAULT_STALE_DAYS = 30;

/**
 * Core gc routine. Pure in terms of return value; `apply=true` also moves
 * files on disk into the trash directory.
 */
export async function runGc(
  workspaceDir: string,
  opts: GcOptions = {},
): Promise<GcReport> {
  const ws = resolveWorkspacePaths(workspaceDir);
  const db = opts.db ?? (await openDb(ws.dbPath));
  migrate(db);

  const staleDays = normalizeStaleDays(opts.staleDays);

  const duplicates = detectDuplicates(db);
  const staleEntries = detectStaleScripts(db, staleDays);

  let trashDir: string | null = null;
  if (opts.apply && staleEntries.length > 0) {
    const nowFn = opts.now ?? (() => new Date());
    trashDir = join(ws.codeModeDir, ".trash", timestampSlug(nowFn()));
    mkdirSync(trashDir, { recursive: true });
    for (const entry of staleEntries) {
      if (!existsSync(entry.path)) continue;
      // Keep filenames stable but dedupe on collision.
      let target = join(trashDir, `${entry.name}.ts`);
      let i = 1;
      while (existsSync(target)) {
        target = join(trashDir, `${entry.name}.${i}.ts`);
        i += 1;
      }
      renameSync(entry.path, target);
      entry.movedTo = target;
    }
  }

  return {
    duplicates,
    stale: staleEntries,
    apply: opts.apply ?? false,
    trashDir,
    staleDays,
  };
}

export async function handler(opts: GcOptions): Promise<void> {
  const workspaceDir = opts.path ?? process.cwd();
  const report = await runGc(workspaceDir, opts);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report);
}

// ───────────────────────────────────────────────────────── duplicate pass ──

/**
 * Compute a normalized form of a TypeScript signature for "are these the same
 * API" comparisons. Intentionally coarse — the agent reviews the output.
 *
 *   - Collapse all runs of whitespace to a single space.
 *   - For each `|`-separated union expression, alphabetize members so
 *     `"a" | "b"` matches `"b" | "a"`.
 *   - Drop trailing semicolons. Leave identifier casing alone.
 */
export function normalizeSignature(sig: string): string {
  const collapsed = sig.replace(/\s+/g, " ").trim().replace(/;+\s*$/, "");
  if (!collapsed.includes("|")) return collapsed;
  // Reorder top-level union members. We only sort the outer pipe; nested
  // unions inside parens/brackets are left untouched (cheap + correct-enough
  // for the common case of `"a" | "b"` or `A | B`).
  return splitTopLevelPipe(collapsed)
    .map((m) => m.trim())
    .sort()
    .join(" | ");
}

function splitTopLevelPipe(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "(" || c === "[" || c === "{" || c === "<") depth += 1;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth -= 1;
    if (c === "|" && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function detectDuplicates(db: Database): DuplicateGroup[] {
  const rows = db.prepare(
    `SELECT id, source_path, kind, name, signature, sdk_name FROM symbols`,
  ).all() as SymbolRowLite[];

  const groups = new Map<string, SymbolRowLite[]>();
  for (const row of rows) {
    const key = `${row.kind}|${normalizeSignature(row.signature)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const dups: DuplicateGroup[] = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    // Skip if all members share the same source_path AND same name — that's
    // just the same symbol re-indexed, not a duplicate.
    const distinctLocations = new Set(
      members.map((m) => `${m.source_path}::${m.name}`),
    );
    if (distinctLocations.size < 2) continue;
    dups.push({
      normalizedSignature: key.split("|").slice(1).join("|"),
      members: members.map((m) => ({
        name: m.name,
        kind: m.kind,
        signature: m.signature,
        sourcePath: m.source_path,
        sdkName: m.sdk_name,
      })),
    });
  }

  // Stable order for deterministic tests/output.
  dups.sort((a, b) =>
    a.normalizedSignature.localeCompare(b.normalizedSignature),
  );
  return dups;
}

// ──────────────────────────────────────────────────────────── stale pass ──

function detectStaleScripts(
  db: Database,
  staleDays: number,
): StaleScriptEntry[] {
  const scripts = db.prepare(
    `SELECT path, name, runs, last_run FROM scripts`,
  ).all() as ScriptRowLite[];

  if (scripts.length === 0) return [];

  // Gather all script source contents once so we can check "no incoming
  // imports" cheaply. We don't need AST fidelity — a substring probe for
  // `from "<relative-path-or-name>"` catches the common cases; callers
  // reviewing gc output still inspect manually before trashing.
  const otherScriptPaths = new Set(scripts.map((s) => s.path));
  const allSources = new Map<string, string>();
  for (const s of scripts) {
    if (!existsSync(s.path)) continue;
    try {
      allSources.set(s.path, readFileSync(s.path, "utf8"));
    } catch {
      // ignore unreadable files
    }
  }

  const candidates: StaleScriptEntry[] = [];
  for (const s of scripts) {
    const age = scriptAgeDays(s.last_run);
    const isAgeStale = age === null ? s.runs === 0 : age >= staleDays;
    if (!isAgeStale) continue;

    if (hasIncomingImport(s, otherScriptPaths, allSources)) continue;

    candidates.push({
      path: s.path,
      name: s.name,
      lastRun: s.last_run,
      ageDays: age === null ? null : Math.round(age),
    });
  }
  // Stable order.
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  return candidates;
}

function scriptAgeDays(lastRun: string | null): number | null {
  if (lastRun === null) return null;
  const parsed = Date.parse(lastRun);
  if (Number.isNaN(parsed)) return null;
  return (Date.now() - parsed) / (1000 * 60 * 60 * 24);
}

/**
 * Heuristic: does any OTHER script's source text reference this script's
 * filename or bare script name via an import-like string? This is
 * intentionally conservative — false positives just keep a script alive,
 * which is the safe direction for gc.
 */
function hasIncomingImport(
  self: ScriptRowLite,
  allScriptPaths: Set<string>,
  allSources: Map<string, string>,
): boolean {
  const needle1 = self.name;
  const needle2 = self.path;
  for (const [path, source] of allSources) {
    if (path === self.path) continue;
    if (!allScriptPaths.has(path)) continue;
    // Look inside import/require-ish strings specifically.
    // Match either bare-name (`from "foo"`), relative (`from "./foo"`),
    // or absolute (`from "/abs/path.ts"`).
    if (
      source.includes(`from "${needle1}"`) ||
      source.includes(`from "./${needle1}"`) ||
      source.includes(`from "../${needle1}"`) ||
      source.includes(`from "${needle2}"`) ||
      source.includes(`require("${needle1}")`) ||
      source.includes(`require("${needle2}")`)
    ) {
      return true;
    }
  }
  return false;
}

// ───────────────────────────────────────────────────────────── misc utils ──

function normalizeStaleDays(raw: number | string | undefined): number {
  if (raw === undefined) return DEFAULT_STALE_DAYS;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STALE_DAYS;
  return n;
}

function timestampSlug(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function printReport(report: GcReport): void {
  console.log(
    `[code-mode gc] duplicates=${report.duplicates.length} ` +
      `stale=${report.stale.length} ` +
      `mode=${report.apply ? "apply" : "dry-run"}`,
  );

  if (report.duplicates.length > 0) {
    console.log("\nDuplicate candidates (normalized-signature grouping):");
    for (const group of report.duplicates) {
      console.log(`  ~ ${group.normalizedSignature}`);
      for (const m of group.members) {
        const sdk = m.sdkName ? ` sdk=${m.sdkName}` : "";
        console.log(`      [${m.kind}] ${m.name}${sdk}  [${m.sourcePath}]`);
      }
    }
  }

  if (report.stale.length > 0) {
    console.log(
      `\nStale scripts (>= ${report.staleDays}d idle + no incoming imports):`,
    );
    for (const s of report.stale) {
      const age = s.ageDays === null ? "never run" : `${s.ageDays}d`;
      console.log(`  - ${s.name}  (${age})  [${s.path}]`);
      if (s.movedTo) console.log(`      moved → ${s.movedTo}`);
    }
  }

  if (report.apply && report.trashDir) {
    console.log(`\nTrash dir: ${report.trashDir}`);
  } else if (!report.apply && report.stale.length > 0) {
    console.log(
      `\nDry-run — pass --apply to move stale scripts into .code-mode/.trash/.`,
    );
  }
}

async function openDb(dbPath: string) {
  const { openDatabase } = await import("../db/open.ts");
  return openDatabase(dbPath);
}
