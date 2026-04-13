import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/open.ts";
import { handler as runHandler } from "../../src/commands/run.ts";
import { handler as saveHandler } from "../../src/commands/save.ts";
import type { RunResult } from "../../src/runner/exec.ts";
import type { SaveResult } from "../../src/commands/save.ts";
import { resolveWorkspacePaths } from "../../src/index/reindex.ts";
import { migrate } from "../../src/db/migrate.ts";

function scaffoldWorkspace(root: string): string {
  const ws = join(root, "ws");
  const codeMode = join(ws, ".code-mode");
  const sdks = join(codeMode, "sdks", "stdlib");
  const scripts = join(codeMode, "scripts");
  mkdirSync(sdks, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(
    join(codeMode, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "esnext",
          module: "preserve",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
        },
        include: ["scripts/**/*.ts", "sdks/**/*.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(sdks, "filter.ts"),
    `export function filter<T>(items: T[], pred: (t: T) => boolean): T[] {
  return items.filter(pred);
}
`,
  );
  const dbPath = join(codeMode, "code-mode.db");
  const db = openDatabase(dbPath);
  migrate(db);
  db.close();
  return ws;
}

describe("run command: usage counters", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-runcmd-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("successful run of a saved script increments runs exactly once", async () => {
    const ws = scaffoldWorkspace(tmpRoot);

    // save a trivial script
    const srcFile = join(tmpRoot, "trivial.ts");
    writeFileSync(
      srcFile,
      `export default async function main(_args: unknown) {
  return { ok: true };
}
`,
    );
    const saveResult = (await saveHandler({
      name: "trivial",
      file: srcFile,
      path: ws,
      _returnResult: true,
    })) as SaveResult;
    expect(saveResult.success).toBe(true);

    const result = (await runHandler({
      mode: "trivial",
      path: ws,
      _returnResult: true,
    })) as RunResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({ ok: true });
    }

    const ws2 = resolveWorkspacePaths(ws);
    const db = openDatabase(ws2.dbPath);
    const row = db
      .prepare(
        `SELECT runs, last_run, success_rate FROM scripts WHERE path = ?`,
      )
      .get(saveResult.path!) as
      | { runs: number; last_run: string; success_rate: number }
      | null;
    expect(row).not.toBeNull();
    expect(row!.runs).toBe(1);
    expect(row!.last_run).toBeTruthy();
    expect(row!.success_rate).toBe(1);
    db.close();

    // Second run bumps to 2.
    const r2 = (await runHandler({
      mode: "trivial",
      path: ws,
      _returnResult: true,
    })) as RunResult;
    expect(r2.success).toBe(true);

    const db2 = openDatabase(ws2.dbPath);
    const row2 = db2
      .prepare(`SELECT runs, success_rate FROM scripts WHERE path = ?`)
      .get(saveResult.path!) as { runs: number; success_rate: number };
    expect(row2.runs).toBe(2);
    expect(row2.success_rate).toBe(1);
    db2.close();
  }, 30_000);

  test("inline run does not touch counters", async () => {
    const ws = scaffoldWorkspace(tmpRoot);
    const inlineFile = join(tmpRoot, "adhoc.ts");
    writeFileSync(
      inlineFile,
      `export default async function main(_args: unknown) { return 7; }
`,
    );

    const result = (await runHandler({
      inline: inlineFile,
      path: ws,
      _returnResult: true,
    })) as RunResult;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toBe(7);
    }

    // Nothing saved in scripts table.
    const ws2 = resolveWorkspacePaths(ws);
    const db = openDatabase(ws2.dbPath);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM scripts`).get() as {
      c: number;
    };
    expect(count.c).toBe(0);
    db.close();
  }, 15_000);
});
