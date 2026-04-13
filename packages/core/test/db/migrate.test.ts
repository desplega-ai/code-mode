import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../src/db/open.ts";
import { migrate, getUserVersion, listMigrations } from "../../src/db/migrate.ts";

const MIGRATIONS_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "db",
  "migrations",
);

function makeMirroredMigrationsDir(): string {
  // Mirror the real migrations dir into a temp folder so individual tests can
  // drop extra `002_noop.sql` / etc. without touching the real source tree.
  const dir = mkdtempSync(join(tmpdir(), "code-mode-migrations-"));
  for (const name of readdirSync(MIGRATIONS_SRC)) {
    copyFileSync(join(MIGRATIONS_SRC, name), join(dir, name));
  }
  return dir;
}

describe("migrate", () => {
  let dbPath: string;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-db-"));
    dbPath = join(tmpRoot, "code-mode.db");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("initial migration creates tables and bumps user_version", () => {
    const db = openDatabase(dbPath);
    const applied = migrate(db);
    expect(applied).toEqual([1]);
    expect(getUserVersion(db)).toBe(1);

    // Confirm expected tables exist.
    const tables = (db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')`)
      .all() as { name: string }[]).map((r) => r.name);
    for (const expected of [
      "scripts",
      "scripts_fts",
      "symbols",
      "symbols_fts",
      "sdks",
    ]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  test("migration runner is idempotent", () => {
    const db = openDatabase(dbPath);
    const applied1 = migrate(db);
    const applied2 = migrate(db);
    expect(applied1.length).toBeGreaterThan(0);
    expect(applied2).toEqual([]); // no-op on second run
    expect(getUserVersion(db)).toBe(applied1[applied1.length - 1]);
    db.close();
  });

  test("running migrate on two separate Database connections gives same user_version", () => {
    const a = openDatabase(dbPath);
    migrate(a);
    const versionA = getUserVersion(a);
    a.close();

    const b = openDatabase(dbPath);
    migrate(b);
    const versionB = getUserVersion(b);
    expect(versionB).toBe(versionA);
    b.close();
  });

  test("adding a stub 002_noop.sql bumps the version pragma", () => {
    const dir = makeMirroredMigrationsDir();
    try {
      // First, apply existing migrations.
      const db = openDatabase(dbPath);
      migrate(db, dir);
      const baseline = getUserVersion(db);
      expect(baseline).toBeGreaterThanOrEqual(1);

      // Now drop a noop migration alongside and rerun.
      writeFileSync(
        join(dir, "002_noop.sql"),
        `-- intentional noop; exercise the version bump path.\nSELECT 1;\n`,
      );
      const applied = migrate(db, dir);
      expect(applied).toEqual([2]);
      expect(getUserVersion(db)).toBe(2);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("listMigrations ignores non-sql and wrong-prefix files", () => {
    const dir = makeMirroredMigrationsDir();
    try {
      writeFileSync(join(dir, "README.md"), "docs");
      writeFileSync(join(dir, "not-a-migration.sql"), "SELECT 1");
      const files = listMigrations(dir);
      // Only the `NNN_*.sql` entries count.
      for (const f of files) {
        expect(f.name).toMatch(/^\d+_/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
