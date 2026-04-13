/**
 * Unit tests for the `list_sdks` MCP handler.
 *
 * Empty-state hint regression guard: MCP callers (agents) get a `note` field
 * pointing at `code-mode reindex` when nothing has been indexed; the happy
 * path stays free of that field so we don't noise up tool output.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/open.ts";
import { migrate } from "../../src/db/migrate.ts";
import { upsertSdk } from "../../src/db/repo.ts";
import { handleListSdks } from "../../src/mcp/handlers/listSdks.ts";

function freshDb() {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

describe("handleListSdks", () => {
  test("empty index → returns sdks=[] with reindex note", () => {
    const db = freshDb();
    const result = handleListSdks(db);
    expect(result.sdks).toEqual([]);
    expect(result.note).toBeTruthy();
    expect(result.note!).toMatch(/code-mode reindex/);
    expect(result.note!).toMatch(/stdlib/);
    db.close();
  });

  test("populated index → no note field", () => {
    const db = freshDb();
    upsertSdk(db, {
      name: "stdlib",
      scope: "stdlib",
      source_dir: "/ws/.code-mode/sdks/stdlib",
      symbol_count: 7,
      last_indexed: new Date().toISOString(),
    });
    const result = handleListSdks(db);
    expect(result.sdks.length).toBe(1);
    expect(result.sdks[0].name).toBe("stdlib");
    expect(result.note).toBeUndefined();
    db.close();
  });
});
