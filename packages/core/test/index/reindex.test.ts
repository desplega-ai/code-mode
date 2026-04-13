import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { reindex, resolveWorkspacePaths } from "../../src/index/reindex.ts";
import { loadProject } from "../../src/analysis/project.ts";
import { listSdks } from "../../src/queries/listSdks.ts";
import { queryTypes } from "../../src/queries/queryTypes.ts";

/**
 * Build a minimal `.code-mode/` fixture under `tmpRoot` with one stdlib file
 * and one user script. We use the in-memory project mode under the hood? No —
 * ts-morph's in-memory FS can't see real files. So we use the real FS path and
 * load a non-in-memory project. Tests stay fast because fixtures are tiny.
 */
function scaffoldFixture(tmpRoot: string): string {
  const ws = join(tmpRoot, "ws");
  const codeMode = join(ws, ".code-mode");
  const sdksStdlib = join(codeMode, "sdks", "stdlib");
  const sdksUser = join(codeMode, "sdks", "mysdk");
  const scripts = join(codeMode, "scripts");
  mkdirSync(sdksStdlib, { recursive: true });
  mkdirSync(sdksUser, { recursive: true });
  mkdirSync(scripts, { recursive: true });

  writeFileSync(
    join(sdksStdlib, "filter.ts"),
    `/**
 * @description Filter an array by a predicate.
 */
export function filter<T>(items: T[], pred: (t: T) => boolean): T[] {
  return items.filter(pred);
}

export type Predicate<T> = (t: T) => boolean;
`.trim(),
  );

  writeFileSync(
    join(sdksStdlib, "flatten.ts"),
    `export function flatten<T>(items: T[][]): T[] {
  return items.reduce<T[]>((acc, next) => acc.concat(next), []);
}
`.trim(),
  );

  writeFileSync(
    join(sdksUser, "greet.ts"),
    `/** @description Say hello */
export function greet(name: string): string { return "hi " + name; }
`.trim(),
  );

  writeFileSync(
    join(scripts, "demo.ts"),
    `/**
 * @description Demo user script.
 * @tags demo, example
 */
export default async function main(args: unknown): Promise<unknown> {
  return { ok: true, args };
}
`.trim(),
  );

  return ws;
}

function openDb(ws: string): Database {
  return new Database(join(ws, ".code-mode", "code-mode.db"));
}

describe("reindex", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-index-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("populates symbols + scripts + sdks and keeps FTS searchable", async () => {
    const ws = scaffoldFixture(tmpRoot);
    const db = openDb(ws);
    const project = loadProject(ws, { inMemory: true });

    // Feed the in-memory project with the fixture files manually so we avoid
    // depending on a real tsconfig being installed in the fixture.
    addFixtureSources(project, ws);

    const report = await reindex(ws, { db, project });
    expect(report.symbolsIndexed).toBeGreaterThan(0);
    expect(report.scriptsIndexed).toBe(1);

    // stdlib and user SDK both surface in listSdks.
    const sdks = listSdks(db);
    const names = sdks.map((s) => s.name);
    expect(names).toContain("stdlib");
    expect(names).toContain("mysdk");
    expect(sdks.find((s) => s.name === "stdlib")!.scope).toBe("stdlib");
    expect(sdks.find((s) => s.name === "mysdk")!.scope).toBe("user");

    // queryTypes returns the filter signature.
    const hits = queryTypes(db, { pattern: "filter" });
    const filterHit = hits.find((h) => h.name === "filter");
    expect(filterHit).toBeDefined();
    expect(filterHit?.signature).toContain("pred");
    expect(filterHit?.sdkName).toBe("stdlib");

    // Kind filter works.
    const onlyTypes = queryTypes(db, { pattern: "", kind: "type" });
    expect(onlyTypes.some((h) => h.name === "Predicate")).toBe(true);

    // SDK filter works.
    const fromMysdk = queryTypes(db, { pattern: "greet", sdk: "mysdk" });
    expect(fromMysdk.some((h) => h.name === "greet")).toBe(true);

    db.close();
  });

  test("deleting a source file and reindexing removes its rows", async () => {
    const ws = scaffoldFixture(tmpRoot);
    const db = openDb(ws);
    const project = loadProject(ws, { inMemory: true });
    addFixtureSources(project, ws);

    await reindex(ws, { db, project });
    const pre = queryTypes(db, { pattern: "flatten" });
    expect(pre.some((h) => h.name === "flatten")).toBe(true);

    // Delete flatten.ts, then reindex. We also have to forget it from the
    // in-memory ts-morph project so the next extract pass doesn't resurrect it.
    const flattenPath = join(
      resolveWorkspacePaths(ws).sdksDir,
      "stdlib",
      "flatten.ts",
    );
    unlinkSync(flattenPath);
    const sf = project.getSourceFile(flattenPath);
    if (sf) project.removeSourceFile(sf);

    const report = await reindex(ws, { db, project });
    expect(report.symbolsRemoved).toBeGreaterThan(0);

    const post = queryTypes(db, { pattern: "flatten" });
    expect(post.some((h) => h.name === "flatten")).toBe(false);

    db.close();
  });

  test("targeted reindex via --paths leaves other files alone", async () => {
    const ws = scaffoldFixture(tmpRoot);
    const db = openDb(ws);
    const project = loadProject(ws, { inMemory: true });
    addFixtureSources(project, ws);

    await reindex(ws, { db, project });

    // Edit filter.ts on disk, but only reindex its path.
    const filterPath = join(resolveWorkspacePaths(ws).sdksDir, "stdlib", "filter.ts");
    const before = queryTypes(db, { pattern: "flatten" });
    expect(before.some((h) => h.name === "flatten")).toBe(true);

    // Mutate filter.ts (add a new export).
    writeFileSync(
      filterPath,
      `/** @description updated */
export function filter<T>(items: T[], pred: (t: T) => boolean): T[] {
  return items.filter(pred);
}
export function filterMap<T, U>(items: T[], fn: (t: T) => U | null): U[] {
  return items.map(fn).filter((x): x is U => x !== null);
}
export type Predicate<T> = (t: T) => boolean;
`.trim(),
    );

    // Refresh in-memory project's source for that file.
    const existing = project.getSourceFile(filterPath);
    if (existing) project.removeSourceFile(existing);
    project.createSourceFile(filterPath, require("node:fs").readFileSync(filterPath, "utf8"));

    await reindex(ws, { db, project, paths: [filterPath] });

    // filterMap should now be present.
    const hits = queryTypes(db, { pattern: "filterMap" });
    expect(hits.some((h) => h.name === "filterMap")).toBe(true);

    // flatten (untouched) still present.
    const flattenHits = queryTypes(db, { pattern: "flatten" });
    expect(flattenHits.some((h) => h.name === "flatten")).toBe(true);

    db.close();
  });
});

/**
 * Add every `.ts` file under the fixture workspace's `.code-mode/sdks` and
 * `.code-mode/scripts` to an in-memory ts-morph project.
 */
function addFixtureSources(project: ReturnType<typeof loadProject>, ws: string): void {
  const fs = require("node:fs");
  const path = require("node:path");
  const ps = resolveWorkspacePaths(ws);
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop()!;
      let entries: any[] = [];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.endsWith(".ts")) out.push(full);
      }
    }
    return out;
  };
  for (const p of [...walk(ps.sdksDir), ...walk(ps.scriptsDir)]) {
    const src = fs.readFileSync(p, "utf8");
    project.createSourceFile(p, src);
  }
}
