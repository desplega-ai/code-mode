/**
 * Prepared-statement helpers over the code-mode SQLite database.
 *
 * Keep CRUD here; avoid putting query logic in reindex/queries modules directly,
 * so schema changes stay confined. FTS5 virtual tables use `content=` so we
 * sync them manually on each mutation (no automatic triggers). All reindex
 * mutations should be wrapped in `withTransaction` for atomicity.
 */

import type { Database } from "better-sqlite3";
import type {
  ScriptRow,
  ScriptStatus,
  SdkRow,
  SdkScope,
  SymbolInsert,
  SymbolRow,
} from "./schema.ts";

export function withTransaction<T>(db: Database, fn: () => T): T {
  return db.transaction(fn)();
}

// ────────────────────────────────────────────────────────────── scripts ──

export interface ScriptUpsert {
  path: string;
  name: string;
  description: string | null;
  tags: string[] | null;
  exportsJson: string;
  signatures: string;       // space-separated, used by FTS
  status?: ScriptStatus;
  statusReason?: string | null;
  indexedAt: string;
}

export function upsertScript(db: Database, s: ScriptUpsert): void {
  const tagsJson = s.tags ? JSON.stringify(s.tags) : null;
  const tagsText = s.tags ? s.tags.join(" ") : null;
  const status = s.status ?? "ok";
  const statusReason = s.statusReason ?? null;

  // Determine rowid so we can keep scripts_fts in sync.
  db.prepare(
    `INSERT INTO scripts
      (path, name, description, tags, exports_json, status, status_reason, indexed_at)
     VALUES
      ($path, $name, $description, $tags, $exports_json, $status, $status_reason, $indexed_at)
     ON CONFLICT(path) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      tags = excluded.tags,
      exports_json = excluded.exports_json,
      status = excluded.status,
      status_reason = excluded.status_reason,
      indexed_at = excluded.indexed_at`,
  ).run({
    path: s.path,
    name: s.name,
    description: s.description,
    tags: tagsJson,
    exports_json: s.exportsJson,
    status: status,
    status_reason: statusReason,
    indexed_at: s.indexedAt,
  });

  const row = db.prepare(`SELECT rowid FROM scripts WHERE path = ?`).get(s.path) as
    | { rowid: number }
    | null;
  if (!row) return;

  // Keep scripts_fts in sync — delete-then-insert is simplest for content= tables.
  db.prepare(`DELETE FROM scripts_fts WHERE rowid = ?`).run(row.rowid);
  db.prepare(
    `INSERT INTO scripts_fts (rowid, name, description, tags, signatures)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.rowid, s.name, s.description ?? "", tagsText ?? "", s.signatures);
}

export function deleteScript(db: Database, path: string): void {
  const row = db.prepare(`SELECT rowid FROM scripts WHERE path = ?`).get(path) as
    | { rowid: number }
    | null;
  if (!row) return;
  db.prepare(`DELETE FROM scripts_fts WHERE rowid = ?`).run(row.rowid);
  db.prepare(`DELETE FROM scripts WHERE path = ?`).run(path);
}

export function listScriptPaths(db: Database): string[] {
  const rows = db.prepare(`SELECT path FROM scripts`).all() as { path: string }[];
  return rows.map((r) => r.path);
}

export function getScript(db: Database, path: string): ScriptRow | null {
  return (db.prepare(`SELECT * FROM scripts WHERE path = ?`).get(path) as
    | ScriptRow
    | null) ?? null;
}

// ────────────────────────────────────────────────────────────── symbols ──

/**
 * Delete every symbol rooted at `source_path`, including its FTS entries.
 */
export function deleteSymbolsByPath(db: Database, sourcePath: string): void {
  const ids = db
    .prepare(`SELECT id FROM symbols WHERE source_path = ?`)
    .all(sourcePath) as { id: number }[];
  if (ids.length === 0) return;
  const delFts = db.prepare(`DELETE FROM symbols_fts WHERE rowid = ?`);
  for (const { id } of ids) {
    delFts.run(id);
  }
  db.prepare(`DELETE FROM symbols WHERE source_path = ?`).run(sourcePath);
}

/**
 * Insert a batch of symbols for a source file. Caller must have deleted any
 * existing rows for that path first (typically via `deleteSymbolsByPath`).
 */
export function insertSymbols(db: Database, symbols: SymbolInsert[]): void {
  const insertSym = db.prepare(
    `INSERT INTO symbols
      (source_path, kind, name, signature, jsdoc, scope, sdk_name)
     VALUES
      ($source_path, $kind, $name, $signature, $jsdoc, $scope, $sdk_name)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO symbols_fts (rowid, name, signature, jsdoc) VALUES (?, ?, ?, ?)`,
  );
  for (const s of symbols) {
    const info = insertSym.run({
      source_path: s.source_path,
      kind: s.kind,
      name: s.name,
      signature: s.signature,
      jsdoc: s.jsdoc,
      scope: s.scope,
      sdk_name: s.sdk_name,
    });
    const id = Number(info.lastInsertRowid);
    insertFts.run(id, s.name, s.signature, s.jsdoc ?? "");
  }
}

export function listSymbolSourcePaths(db: Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT source_path FROM symbols`)
    .all() as { source_path: string }[];
  return rows.map((r) => r.source_path);
}

export function getSymbolsByPath(db: Database, sourcePath: string): SymbolRow[] {
  return db
    .prepare(`SELECT * FROM symbols WHERE source_path = ?`)
    .all(sourcePath) as SymbolRow[];
}

// ───────────────────────────────────────────────────────────────── sdks ──

export function upsertSdk(db: Database, sdk: SdkRow): void {
  db.prepare(
    `INSERT INTO sdks (name, scope, source_dir, symbol_count, last_indexed)
     VALUES ($name, $scope, $source_dir, $symbol_count, $last_indexed)
     ON CONFLICT(name) DO UPDATE SET
      scope = excluded.scope,
      source_dir = excluded.source_dir,
      symbol_count = excluded.symbol_count,
      last_indexed = excluded.last_indexed`,
  ).run({
    name: sdk.name,
    scope: sdk.scope,
    source_dir: sdk.source_dir,
    symbol_count: sdk.symbol_count,
    last_indexed: sdk.last_indexed,
  });
}

export function deleteSdk(db: Database, name: string): void {
  db.prepare(`DELETE FROM sdks WHERE name = ?`).run(name);
}

export function listSdkRows(db: Database): SdkRow[] {
  return db.prepare(`SELECT * FROM sdks ORDER BY name`).all() as SdkRow[];
}

export function getSdkNamesByScope(db: Database, scope: SdkScope): string[] {
  const rows = db
    .prepare(`SELECT name FROM sdks WHERE scope = ?`)
    .all(scope) as { name: string }[];
  return rows.map((r) => r.name);
}
