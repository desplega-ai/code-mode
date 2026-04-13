/**
 * End-to-end tests for `code-mode doctor`.
 *
 * Flow: scaffold a mini-workspace, reindex it so the DB has script rows,
 * break one script's source, then run `runDoctor` — we assert the broken
 * script gets `status='unusable'` in the DB and drops out of `search`,
 * while `queryTypes` (status-unaware) still finds its symbols.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../../src/db/open.ts";
import { reindex } from "../../src/index/reindex.ts";
import { loadProject } from "../../src/analysis/project.ts";
import { search } from "../../src/queries/search.ts";
import { queryTypes } from "../../src/queries/queryTypes.ts";
import { runDoctor } from "../../src/commands/doctor.ts";

function scaffold(tmpRoot: string): string {
  const ws = join(tmpRoot, "ws");
  const scripts = join(ws, ".code-mode", "scripts");
  const sdksStdlib = join(ws, ".code-mode", "sdks", "stdlib");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(sdksStdlib, { recursive: true });

  writeFileSync(
    join(sdksStdlib, "filter.ts"),
    `export function filter<T>(items: T[], pred: (t: T) => boolean): T[] {
  return items.filter(pred);
}
`,
  );

  writeFileSync(
    join(scripts, "good.ts"),
    `/** @description a clean, healthy script */
export default async function main(_input: unknown): Promise<number> {
  const n: number = 42;
  return n;
}
`,
  );

  writeFileSync(
    join(scripts, "broken.ts"),
    `/** @description a script that typechecks cleanly at first */
export default async function main(_input: unknown): Promise<string> {
  return "ok";
}
`,
  );

  return ws;
}

function openDb(ws: string): Database {
  return openDatabase(join(ws, ".code-mode", "code-mode.db"));
}

function addSources(project: ReturnType<typeof loadProject>, ws: string) {
  const fs = require("node:fs");
  const walk = (d: string): string[] => {
    const out: string[] = [];
    const stack = [d];
    while (stack.length) {
      const cur = stack.pop()!;
      let entries: any[] = [];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.endsWith(".ts")) out.push(full);
      }
    }
    return out;
  };
  const root = join(ws, ".code-mode");
  for (const p of walk(root)) {
    project.createSourceFile(p, fs.readFileSync(p, "utf8"));
  }
}

describe("doctor", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-doctor-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("marks a broken script unusable + excludes it from search", async () => {
    const ws = scaffold(tmpRoot);
    const db = openDb(ws);
    const project = loadProject(ws, { inMemory: true });
    addSources(project, ws);

    await reindex(ws, { db, project });

    // Both scripts present in search initially.
    const preNames = search(db, { query: "" }).map((h) => h.name);
    expect(preNames).toContain("good");
    expect(preNames).toContain("broken");

    // Break the script by introducing a type error. Also sync the in-memory
    // ts-morph source so the doctor's typecheck sees the new contents.
    const brokenPath = join(ws, ".code-mode", "scripts", "broken.ts");
    const brokenSource = `/** @description script with a type error */
export default async function main(_input: unknown): Promise<string> {
  const n: number = "not a number";
  return n;
}
`;
    writeFileSync(brokenPath, brokenSource);
    const existing = project.getSourceFile(brokenPath);
    if (existing) project.removeSourceFile(existing);
    project.createSourceFile(brokenPath, brokenSource);

    const report = await runDoctor(ws, { db, project });
    expect(report.broken.some((b) => b.name === "broken")).toBe(true);
    expect(report.broken.some((b) => b.name === "good")).toBe(false);

    // DB flipped to unusable.
    const row = db
      .prepare(`SELECT status, status_reason FROM scripts WHERE name = 'broken'`)
      .get() as { status: string; status_reason: string | null };
    expect(row.status).toBe("unusable");
    expect(row.status_reason).not.toBeNull();

    // Search excludes the broken script.
    const hits = search(db, { query: "broken" });
    expect(hits.some((h) => h.name === "broken")).toBe(false);

    // queryTypes still surfaces stdlib symbols (status-unaware).
    const types = queryTypes(db, { pattern: "filter" });
    expect(types.some((t) => t.name === "filter")).toBe(true);

    db.close();
  });

  test("freshness mismatch: mtime newer than indexed_at is surfaced", async () => {
    const ws = scaffold(tmpRoot);
    const db = openDb(ws);
    const project = loadProject(ws, { inMemory: true });
    addSources(project, ws);
    await reindex(ws, { db, project });

    // Rewind the indexed_at of the good script so its mtime is newer than
    // the recorded index time (simulates a file edited since last reindex).
    const old = "2001-01-01T00:00:00.000Z";
    db.prepare(`UPDATE scripts SET indexed_at = $t WHERE name = 'good'`).run({
      t: old,
    });

    const report = await runDoctor(ws, { db, project });
    expect(report.freshness.some((f) => f.name === "good")).toBe(true);

    db.close();
  });

  test("recovers: a previously unusable script that typechecks clean flips back to ok", async () => {
    const ws = scaffold(tmpRoot);
    const db = openDb(ws);
    const project = loadProject(ws, { inMemory: true });
    addSources(project, ws);
    await reindex(ws, { db, project });

    // Manually flip the status — simulates a previous doctor run.
    db.prepare(
      `UPDATE scripts SET status = 'unusable', status_reason = 'old failure' WHERE name = 'good'`,
    ).run();

    const report = await runDoctor(ws, { db, project });
    const okRow = db
      .prepare(`SELECT status, status_reason FROM scripts WHERE name = 'good'`)
      .get() as { status: string; status_reason: string | null };
    expect(okRow.status).toBe("ok");
    expect(okRow.status_reason).toBeNull();
    expect(report.broken.some((b) => b.name === "good")).toBe(false);

    db.close();
  });

  test("JSON contract: structured report is serializable", async () => {
    const ws = scaffold(tmpRoot);
    const db = openDb(ws);
    const project = loadProject(ws, { inMemory: true });
    addSources(project, ws);
    await reindex(ws, { db, project });

    const report = await runDoctor(ws, { db, project, staleDays: 9999 });
    const roundTrip = JSON.parse(JSON.stringify(report));
    expect(roundTrip.scriptsChecked).toBe(2);
    expect(typeof roundTrip.staleDays).toBe("number");
    expect(Array.isArray(roundTrip.broken)).toBe(true);
    expect(Array.isArray(roundTrip.stale)).toBe(true);
    // Also confirm no stale entries bubble up when the threshold is huge.
    expect(roundTrip.stale.every((s: { lastRun: string | null }) => s.lastRun === null)).toBe(true);

    // Sanity: reading the broken script source (unused import to keep bundler
    // quiet if we ever prune).
    readFileSync(join(ws, ".code-mode", "scripts", "broken.ts"), "utf8");

    db.close();
  });
});
