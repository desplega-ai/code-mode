import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../../src/db/open.ts";
import { migrate } from "../../src/db/migrate.ts";
import {
  deleteScript,
  deleteSymbolsByPath,
  getScript,
  getSymbolsByPath,
  insertSymbols,
  listScriptPaths,
  listSymbolSourcePaths,
  listSdkRows,
  upsertScript,
  upsertSdk,
  withTransaction,
} from "../../src/db/repo.ts";
import { queryTypes } from "../../src/queries/queryTypes.ts";
import { listSdks } from "../../src/queries/listSdks.ts";

describe("repo CRUD", () => {
  let tmpRoot: string;
  let db: Database;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-repo-"));
    db = openDatabase(join(tmpRoot, "code-mode.db"));
    migrate(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("upsertScript inserts then updates, keeping scripts_fts in sync", () => {
    withTransaction(db, () => {
      upsertScript(db, {
        path: "/ws/scripts/demo.ts",
        name: "demo",
        description: "demo script",
        tags: ["alpha"],
        exportsJson: "[]",
        signatures: "main(args: unknown): Promise<unknown>",
        indexedAt: "2026-04-13T00:00:00.000Z",
      });
    });

    let row = getScript(db, "/ws/scripts/demo.ts");
    expect(row?.name).toBe("demo");
    expect(row?.description).toBe("demo script");

    // FTS lookup.
    const hits = db
      .prepare(`SELECT name FROM scripts_fts WHERE scripts_fts MATCH 'demo'`)
      .all() as { name: string }[];
    expect(hits.some((h) => h.name === "demo")).toBe(true);

    // Re-upsert with a new description/tags.
    withTransaction(db, () => {
      upsertScript(db, {
        path: "/ws/scripts/demo.ts",
        name: "demo",
        description: "updated description",
        tags: ["beta"],
        exportsJson: "[]",
        signatures: "main(args: unknown): Promise<unknown>",
        indexedAt: "2026-04-13T00:01:00.000Z",
      });
    });
    row = getScript(db, "/ws/scripts/demo.ts");
    expect(row?.description).toBe("updated description");

    // Only a single rowid should still exist in scripts_fts.
    const cnt = db
      .prepare(`SELECT COUNT(*) as c FROM scripts_fts WHERE scripts_fts MATCH 'updated'`)
      .get() as { c: number };
    expect(cnt.c).toBe(1);
  });

  test("deleteScript removes from both scripts and scripts_fts", () => {
    withTransaction(db, () => {
      upsertScript(db, {
        path: "/ws/scripts/gone.ts",
        name: "gone",
        description: "temp",
        tags: null,
        exportsJson: "[]",
        signatures: "",
        indexedAt: "2026-04-13T00:00:00.000Z",
      });
    });
    expect(listScriptPaths(db)).toContain("/ws/scripts/gone.ts");
    deleteScript(db, "/ws/scripts/gone.ts");
    expect(listScriptPaths(db)).not.toContain("/ws/scripts/gone.ts");
    const hits = db
      .prepare(`SELECT COUNT(*) as c FROM scripts_fts WHERE scripts_fts MATCH 'gone'`)
      .get() as { c: number };
    expect(hits.c).toBe(0);
  });

  test("insertSymbols + deleteSymbolsByPath round-trips through symbols_fts", () => {
    withTransaction(db, () => {
      insertSymbols(db, [
        {
          source_path: "/ws/sdks/stdlib/filter.ts",
          kind: "function",
          name: "filter",
          signature: "filter<T>(items: T[], pred: (t: T) => boolean): T[]",
          jsdoc: "Filter an array by predicate",
          scope: "stdlib",
          sdk_name: "stdlib",
        },
        {
          source_path: "/ws/sdks/stdlib/filter.ts",
          kind: "type",
          name: "Predicate",
          signature: "type Predicate<T> = (t: T) => boolean",
          jsdoc: null,
          scope: "stdlib",
          sdk_name: "stdlib",
        },
      ]);
    });

    expect(listSymbolSourcePaths(db)).toEqual(["/ws/sdks/stdlib/filter.ts"]);
    expect(getSymbolsByPath(db, "/ws/sdks/stdlib/filter.ts")).toHaveLength(2);

    const matches = queryTypes(db, { pattern: "filter" });
    expect(matches.some((m) => m.name === "filter")).toBe(true);

    deleteSymbolsByPath(db, "/ws/sdks/stdlib/filter.ts");
    expect(getSymbolsByPath(db, "/ws/sdks/stdlib/filter.ts")).toHaveLength(0);
    const afterDelete = queryTypes(db, { pattern: "filter" });
    expect(afterDelete).toHaveLength(0);
  });

  test("upsertSdk + listSdkRows + listSdks surface summaries", () => {
    withTransaction(db, () => {
      upsertSdk(db, {
        name: "stdlib",
        scope: "stdlib",
        source_dir: "/ws/.code-mode/sdks/stdlib",
        symbol_count: 4,
        last_indexed: "2026-04-13T00:00:00.000Z",
      });
    });
    const rows = listSdkRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("stdlib");

    const summaries = listSdks(db);
    expect(summaries[0]?.symbolCount).toBe(4);
    expect(summaries[0]?.sourceDir).toBe("/ws/.code-mode/sdks/stdlib");
  });
});
