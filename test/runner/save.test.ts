import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { handler as saveHandler } from "../../src/commands/save.ts";
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
  // Empty DB so updateUsageCounter can work without needing reindex first.
  const dbPath = join(codeMode, "code-mode.db");
  const db = new Database(dbPath);
  migrate(db);
  db.close();
  return ws;
}

describe("save command", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-save-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("saves a valid script and reindexes", async () => {
    const ws = scaffoldWorkspace(tmpRoot);

    // Write source in a temp file.
    const srcFile = join(tmpRoot, "hello.ts");
    writeFileSync(
      srcFile,
      `export default async function main(_args: unknown) {
  return { hello: "world" };
}
`,
    );

    const result = (await saveHandler({
      name: "hello",
      file: srcFile,
      path: ws,
      _returnResult: true,
    })) as SaveResult;

    expect(result.success).toBe(true);
    const ws2 = resolveWorkspacePaths(ws);
    const savedPath = join(ws2.scriptsDir, "hello.ts");
    expect(existsSync(savedPath)).toBe(true);

    // Reindex populated the scripts table.
    const db = new Database(ws2.dbPath);
    const row = db
      .query("SELECT path, name FROM scripts WHERE path = ?")
      .get(savedPath) as { path: string; name: string } | null;
    expect(row).not.toBeNull();
    expect(row!.name).toBe("hello");
    db.close();
  });

  test("rejects a broken script and removes the file", async () => {
    const ws = scaffoldWorkspace(tmpRoot);

    const srcFile = join(tmpRoot, "broken.ts");
    writeFileSync(
      srcFile,
      `export default async function main(_args: unknown) {
  const n: number = "not a number"; // TS error
  return n;
}
`,
    );

    const result = (await saveHandler({
      name: "broken",
      file: srcFile,
      path: ws,
      _returnResult: true,
    })) as SaveResult;

    expect(result.success).toBe(false);
    expect(result.diagnostics?.length).toBeGreaterThan(0);

    const ws2 = resolveWorkspacePaths(ws);
    const targetPath = join(ws2.scriptsDir, "broken.ts");
    expect(existsSync(targetPath)).toBe(false);
  });

  test("refuses to overwrite without --overwrite", async () => {
    const ws = scaffoldWorkspace(tmpRoot);
    const ws2 = resolveWorkspacePaths(ws);
    const targetPath = join(ws2.scriptsDir, "dup.ts");
    writeFileSync(
      targetPath,
      `export default async function main(_args: unknown) { return 1; }
`,
    );

    const srcFile = join(tmpRoot, "dup.ts");
    writeFileSync(
      srcFile,
      `export default async function main(_args: unknown) { return 2; }
`,
    );

    const result = (await saveHandler({
      name: "dup",
      file: srcFile,
      path: ws,
      _returnResult: true,
    })) as SaveResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
  });
});
