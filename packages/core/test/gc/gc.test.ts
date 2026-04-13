/**
 * End-to-end tests for `code-mode gc`.
 *
 * We seed an in-memory DB + a real on-disk scripts dir, then:
 *   - Verify duplicate detection groups symbols with the same normalized
 *     signature across different source paths.
 *   - Verify stale detection flags never-run scripts with no incoming
 *     imports, and leaves imported scripts alone.
 *   - Verify `--apply` moves stale files into `.code-mode/.trash/<ts>/`
 *     without deleting the source tree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../../src/db/open.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertSymbols, upsertScript } from "../../src/db/repo.ts";
import { normalizeSignature, runGc } from "../../src/commands/gc.ts";

function scaffold(tmpRoot: string): { ws: string; scriptsDir: string } {
  const ws = join(tmpRoot, "ws");
  const scriptsDir = join(ws, ".code-mode", "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  return { ws, scriptsDir };
}

function openInMemory(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

describe("gc/normalizeSignature", () => {
  test("alphabetizes union members", () => {
    expect(normalizeSignature(`"b" | "a"`)).toBe(`"a" | "b"`);
    expect(normalizeSignature(`B | A | C`)).toBe(`A | B | C`);
  });

  test("collapses whitespace", () => {
    expect(normalizeSignature("(x:  number) =>  number")).toBe(
      "(x: number) => number",
    );
  });

  test("leaves non-union signatures alone", () => {
    expect(normalizeSignature("(x: number) => number")).toBe(
      "(x: number) => number",
    );
  });
});

describe("gc/duplicates", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-gc-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("dry-run lists a planted duplicate pair", async () => {
    const { ws } = scaffold(tmpRoot);
    const db = openInMemory();

    // Two different source files expose the same type under different names.
    insertSymbols(db, [
      {
        source_path: "/ws/.code-mode/sdks/a/types.ts",
        kind: "type",
        name: "Priority",
        signature: `"low" | "medium" | "high"`,
        jsdoc: null,
        scope: "sdk",
        sdk_name: "a",
      },
      {
        source_path: "/ws/.code-mode/sdks/b/types.ts",
        kind: "type",
        name: "Severity",
        // Same members, different order — normalization should catch it.
        signature: `"high" | "low" | "medium"`,
        jsdoc: null,
        scope: "sdk",
        sdk_name: "b",
      },
      // Unrelated, should not appear in the group.
      {
        source_path: "/ws/.code-mode/sdks/c/other.ts",
        kind: "function",
        name: "loneWolf",
        signature: "(x: number) => number",
        jsdoc: null,
        scope: "sdk",
        sdk_name: "c",
      },
    ]);

    const report = await runGc(ws, { db });
    expect(report.duplicates).toHaveLength(1);
    const group = report.duplicates[0]!;
    const names = group.members.map((m) => m.name).sort();
    expect(names).toEqual(["Priority", "Severity"]);
    expect(report.apply).toBe(false);
    expect(report.trashDir).toBeNull();

    db.close();
  });

  test("does not flag identical signatures at the same path+name", async () => {
    const { ws } = scaffold(tmpRoot);
    const db = openInMemory();

    // Same symbol indexed twice by path — gc shouldn't treat that as dup.
    // (Schema allows both inserts since symbols.id is auto-incremented.)
    insertSymbols(db, [
      {
        source_path: "/ws/.code-mode/sdks/a/only.ts",
        kind: "function",
        name: "run",
        signature: "() => void",
        jsdoc: null,
        scope: "sdk",
        sdk_name: "a",
      },
      {
        source_path: "/ws/.code-mode/sdks/a/only.ts",
        kind: "function",
        name: "run",
        signature: "() => void",
        jsdoc: null,
        scope: "sdk",
        sdk_name: "a",
      },
    ]);

    const report = await runGc(ws, { db });
    expect(report.duplicates).toHaveLength(0);

    db.close();
  });
});

describe("gc/stale", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-gc-stale-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("--apply moves stale scripts into .trash/<ts>/", async () => {
    const { ws, scriptsDir } = scaffold(tmpRoot);
    const db = openInMemory();

    // Two never-run scripts on disk. One is imported by the other, so only
    // the un-imported one should be flagged as stale.
    const abandonedPath = join(scriptsDir, "abandoned.ts");
    const referencedPath = join(scriptsDir, "referenced.ts");
    const importerPath = join(scriptsDir, "importer.ts");

    writeFileSync(abandonedPath, `export default async function main() { return 1; }\n`);
    writeFileSync(referencedPath, `export function used(): number { return 1; }\n`);
    writeFileSync(
      importerPath,
      `import { used } from "./referenced";\n` +
        `export default async function main() { return used(); }\n`,
    );

    for (const p of [abandonedPath, referencedPath, importerPath]) {
      upsertScript(db, {
        path: p,
        name: p.split("/").pop()!.replace(/\.ts$/, ""),
        description: null,
        tags: null,
        exportsJson: "[]",
        signatures: "",
        indexedAt: new Date().toISOString(),
      });
    }

    // Dry-run: abandoned surfaces; referenced stays alive; importer stays
    // alive (also run=0 but it's the one doing the importing — and there's
    // no code referencing IT, so actually we expect importer to be stale too.
    // To keep this test focused on the imports rule, also mark importer as
    // recently run so it's not stale by age.
    db.prepare(
      `UPDATE scripts SET runs = 5, last_run = $now WHERE name = 'importer'`,
    ).run({ now: new Date().toISOString() });

    const dry = await runGc(ws, { db });
    const staleNames = dry.stale.map((s) => s.name).sort();
    expect(staleNames).toContain("abandoned");
    expect(staleNames).not.toContain("referenced"); // imported
    expect(staleNames).not.toContain("importer"); // recently run

    // Apply: abandoned moves to trash; source file no longer at original path.
    const now = new Date("2026-04-13T12:34:56.000Z");
    const applied = await runGc(ws, { db, apply: true, now: () => now });
    expect(applied.apply).toBe(true);
    expect(applied.trashDir).not.toBeNull();
    expect(applied.trashDir).toContain("20260413-123456");
    expect(existsSync(applied.trashDir!)).toBe(true);
    expect(existsSync(abandonedPath)).toBe(false);

    const trashFiles = readdirSync(applied.trashDir!);
    expect(trashFiles).toContain("abandoned.ts");

    // Non-stale files untouched.
    expect(existsSync(referencedPath)).toBe(true);
    expect(existsSync(importerPath)).toBe(true);

    // The moved entry records its destination.
    const abandonedEntry = applied.stale.find((s) => s.name === "abandoned");
    expect(abandonedEntry?.movedTo).toBeDefined();
    expect(abandonedEntry!.movedTo!.endsWith("abandoned.ts")).toBe(true);

    db.close();
  });

  test("dry-run never moves files", async () => {
    const { ws, scriptsDir } = scaffold(tmpRoot);
    const db = openInMemory();
    const path = join(scriptsDir, "orphan.ts");
    writeFileSync(path, `export default async function main() { return 1; }\n`);
    upsertScript(db, {
      path,
      name: "orphan",
      description: null,
      tags: null,
      exportsJson: "[]",
      signatures: "",
      indexedAt: new Date().toISOString(),
    });

    const report = await runGc(ws, { db });
    expect(report.stale.some((s) => s.name === "orphan")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(report.trashDir).toBeNull();

    db.close();
  });
});
