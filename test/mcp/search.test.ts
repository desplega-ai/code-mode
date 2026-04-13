/**
 * Unit tests for the `search` query — in-memory DB so we can assert the
 * merge + status filter without spinning up a workspace.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/db/migrate.ts";
import { upsertScript, insertSymbols } from "../../src/db/repo.ts";
import { search } from "../../src/queries/search.ts";

function seed(db: Database) {
  upsertScript(db, {
    path: "/ws/.code-mode/scripts/good.ts",
    name: "good_script",
    description: "a known-good script",
    tags: ["sample"],
    exportsJson: "[]",
    signatures: "greet()",
    indexedAt: new Date().toISOString(),
  });
  upsertScript(db, {
    path: "/ws/.code-mode/scripts/broken.ts",
    name: "broken_script",
    description: "a broken script — should not appear in search",
    tags: null,
    exportsJson: "[]",
    signatures: "broken()",
    status: "unusable",
    statusReason: "typecheck failed",
    indexedAt: new Date().toISOString(),
  });
  insertSymbols(db, [
    {
      source_path: "/ws/.code-mode/sdks/stdlib/filter.ts",
      kind: "function",
      name: "filter",
      signature: "<T>(items: T[], pred: (t: T) => boolean) => T[]",
      jsdoc: "Keep matching items.",
      scope: "stdlib",
      sdk_name: "stdlib",
    },
  ]);
}

describe("search", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    seed(db);
  });

  test("returns good scripts but not unusable ones", () => {
    const hits = search(db, { query: "script" });
    const names = hits.map((h) => h.name);
    expect(names).toContain("good_script");
    expect(names).not.toContain("broken_script");
  });

  test("finds symbols via FTS", () => {
    const hits = search(db, { query: "filter" });
    expect(hits.some((h) => h.name === "filter" && h.kind === "function")).toBe(true);
  });

  test("scope='script' excludes symbol hits", () => {
    const hits = search(db, { query: "filter", scope: "script" });
    expect(hits.every((h) => h.scope === "script")).toBe(true);
  });

  test("scope='stdlib' excludes script hits", () => {
    const hits = search(db, { query: "filter", scope: "stdlib" });
    expect(hits.every((h) => h.scope === "stdlib")).toBe(true);
  });
});
