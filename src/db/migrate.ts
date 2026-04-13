/**
 * Tiny hand-rolled migration runner.
 *
 * Scans `src/db/migrations/*.sql` for files prefixed with a zero-padded version
 * number (e.g. `001_initial.sql`), applies any whose version is greater than
 * `PRAGMA user_version`, and bumps the pragma to the highest applied version.
 *
 * Each migration runs inside its own transaction. If a migration fails the
 * transaction rolls back and `user_version` is left unchanged.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";

export interface MigrationFile {
  version: number;
  name: string;
  absPath: string;
}

const DEFAULT_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

/**
 * List migrations on disk, sorted ascending by version.
 */
export function listMigrations(
  dir: string = DEFAULT_MIGRATIONS_DIR,
): MigrationFile[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const match = entry.name.match(/^(\d+)_/);
    if (!match) continue;
    files.push({
      version: Number(match[1]),
      name: entry.name,
      absPath: join(dir, entry.name),
    });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

/**
 * Apply all pending migrations and bump `PRAGMA user_version`.
 * Returns the list of versions applied.
 */
export function migrate(
  db: Database,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): number[] {
  const current = getUserVersion(db);
  const applied: number[] = [];
  for (const file of listMigrations(dir)) {
    if (file.version <= current) continue;
    const sql = readFileSync(file.absPath, "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${file.version}`);
    })();
    applied.push(file.version);
  }
  return applied;
}

export function getUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as
    | { user_version: number }
    | null;
  return row?.user_version ?? 0;
}
