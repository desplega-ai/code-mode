/**
 * Tests for the SDK-enumeration helpers in `plugins/code-mode/hooks/_shared.mjs`.
 * Exercises `scanSdks`, `findGeneratedTool`, `buildTypedSdkSnippet`, and
 * `listSavedScripts` against a synthetic workspace.
 *
 * These helpers are on the hot path for SessionStart + PreToolUse, so we
 * pin their output shape here to prevent silent regressions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let shared: any;

beforeEach(async () => {
  const modPath = resolve(
    import.meta.dir,
    "../../../..",
    "plugins/code-mode/hooks/_shared.mjs",
  );
  // Fresh import per test to keep any module-level caches from bleeding.
  shared = await import(`${modPath}?t=${Date.now()}`);
});

function makeWs(): string {
  return mkdtempSync(join(tmpdir(), "cm-sdk-enum-"));
}

function writeStdlib(ws: string, name: string, body: string) {
  const dir = join(ws, ".code-mode", "sdks", "stdlib");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.ts`), body, "utf8");
}

function writeGeneratedServer(ws: string, slug: string, body: string) {
  const dir = join(ws, ".code-mode", "sdks", ".generated");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.ts`), body, "utf8");
}

describe("scanSdks", () => {
  let ws: string;
  beforeEach(() => {
    ws = makeWs();
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  test("missing .code-mode → []", () => {
    expect(shared.scanSdks(ws)).toEqual([]);
  });

  test("stdlib + generated servers enumerated with abbreviated signatures", () => {
    writeStdlib(
      ws,
      "fetch",
      `export async function getJson<T = unknown>(url: string, init?: unknown): Promise<T> { return {} as T }\n`,
    );
    writeStdlib(
      ws,
      "grep",
      `export interface GrepOptions { pattern: string }\nexport function grep(pattern: string, options: GrepOptions = { pattern: "" }): string[] { return [] }\n`,
    );
    writeGeneratedServer(
      ws,
      "dbhub",
      `import { callTool } from "./_client";
export interface ExecuteSqlArgs {
  /** SQL */
  sql: string;
}
export type ExecuteSqlResult = unknown;
export async function executeSql(args: ExecuteSqlArgs): Promise<ExecuteSqlResult> { return callTool("dbhub","execute_sql",args as unknown as Record<string, unknown>) as Promise<ExecuteSqlResult> }

export interface SearchObjectsArgs {
  pattern: string;
  limit?: number;
}
export type SearchObjectsResult = unknown;
export async function searchObjects(args: SearchObjectsArgs): Promise<SearchObjectsResult> { return callTool("dbhub","search_objects",args as unknown as Record<string, unknown>) as Promise<SearchObjectsResult> }
`,
    );

    const sdks = shared.scanSdks(ws);
    const names = sdks.map((s: { name: string }) => s.name);
    expect(names).toContain("stdlib");
    expect(names).toContain("dbhub");

    const stdlib = sdks.find((s: { name: string }) => s.name === "stdlib");
    expect(stdlib.exports.some((e: string) => e.startsWith("getJson("))).toBe(true);
    expect(stdlib.exports.some((e: string) => e.startsWith("grep("))).toBe(true);

    const dbhub = sdks.find((s: { name: string }) => s.name === "dbhub");
    expect(dbhub.exports).toContain("executeSql({ sql })");
    expect(dbhub.exports).toContain("searchObjects({ pattern, limit? })");
  });

  test("skips _client.ts and _servers.json under .generated", () => {
    writeGeneratedServer(ws, "_client", `export const x = 1;\n`);
    writeFileSync(
      join(ws, ".code-mode", "sdks", ".generated", "_servers.json"),
      "{}",
      "utf8",
    );
    writeGeneratedServer(
      ws,
      "okserver",
      `export async function doThing(args: DoThingArgs): Promise<void> {}
export interface DoThingArgs { foo: string }
`,
    );
    const sdks = shared.scanSdks(ws);
    expect(sdks.map((s: { name: string }) => s.name)).toEqual(["okserver"]);
  });

  test("long export lists are truncated", () => {
    const fns: string[] = [];
    for (let i = 0; i < 15; i++) {
      fns.push(
        `export interface Tool${i}Args { x: string }\nexport async function tool${i}(args: Tool${i}Args): Promise<void> {}\n`,
      );
    }
    writeGeneratedServer(ws, "bigserver", fns.join("\n"));
    const sdks = shared.scanSdks(ws);
    const big = sdks.find((s: { name: string }) => s.name === "bigserver");
    expect(big.exports.length).toBe(15);

    const rendered = shared.renderSdkSummary(sdks);
    expect(rendered).toMatch(/bigserver:/);
    expect(rendered).toMatch(/more — __query_types/);
  });
});

describe("findGeneratedTool / buildTypedSdkSnippet", () => {
  let ws: string;
  beforeEach(() => {
    ws = makeWs();
    writeGeneratedServer(
      ws,
      "dbhub",
      `import { callTool } from "./_client";
export interface ExecuteSqlArgs { sql: string }
export type ExecuteSqlResult = unknown;
export async function executeSql(args: ExecuteSqlArgs): Promise<ExecuteSqlResult> { return callTool("dbhub","execute_sql",args as unknown as Record<string, unknown>) as Promise<ExecuteSqlResult> }

export interface SearchObjectsArgs { pattern: string }
export type SearchObjectsResult = unknown;
export async function searchObjects(args: SearchObjectsArgs): Promise<SearchObjectsResult> { return callTool("dbhub","search_objects",args as unknown as Record<string, unknown>) as Promise<SearchObjectsResult> }
`,
    );
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  test("maps mcp__dbhub__execute_sql → executeSql wrapper", () => {
    const hit = shared.findGeneratedTool("mcp__dbhub__execute_sql", ws);
    expect(hit).not.toBeNull();
    expect(hit.fnName).toBe("executeSql");
    expect(hit.server).toBe("dbhub");
    expect(hit.importPath).toBe("@/sdks/.generated/dbhub");
    expect(hit.siblingFns).toEqual(["searchObjects({ pattern })"]);
  });

  test("buildTypedSdkSnippet emits a runnable TS source block", () => {
    const out = shared.buildTypedSdkSnippet("mcp__dbhub__execute_sql", ws);
    expect(out).not.toBeNull();
    expect(out.server).toBe("dbhub");
    expect(out.snippet).toContain(
      `import { executeSql } from "@/sdks/.generated/dbhub";`,
    );
    expect(out.snippet).toContain("const result = await executeSql(");
    expect(out.snippet).toContain("console.log(JSON.stringify(result));");
  });

  test("returns null when the server has no generated SDK", () => {
    expect(shared.findGeneratedTool("mcp__ghostsvc__frobnicate", ws)).toBeNull();
    expect(shared.buildTypedSdkSnippet("mcp__ghostsvc__frobnicate", ws)).toBeNull();
  });

  test("returns null when the tool isn't in the server's module", () => {
    expect(shared.findGeneratedTool("mcp__dbhub__drop_database", ws)).toBeNull();
  });
});

describe("listSavedScripts", () => {
  let ws: string;
  beforeEach(() => {
    ws = makeWs();
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  test("empty workspace → { names: [], total: 0 }", () => {
    const out = shared.listSavedScripts(ws);
    expect(out.total).toBe(0);
    expect(out.names).toEqual([]);
  });

  test("flat + nested scripts reported relative to scripts dir, newest first", () => {
    const dir = join(ws, ".code-mode", "scripts");
    mkdirSync(join(dir, "dbhub"), { recursive: true });
    writeFileSync(join(dir, "a.ts"), "export default async () => {}\n");
    writeFileSync(join(dir, "dbhub", "query-users.ts"), "export default async () => {}\n");

    const out = shared.listSavedScripts(ws);
    expect(out.total).toBe(2);
    expect(out.names).toContain("a");
    expect(out.names).toContain("dbhub/query-users");
  });
});
