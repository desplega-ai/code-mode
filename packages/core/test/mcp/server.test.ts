/**
 * MCP server integration test.
 *
 * Spawns `bun run bin/code-mode.ts mcp --path <tmp-workspace>` as a subprocess,
 * connects with the MCP client SDK via stdio, and calls each of the five tools.
 *
 * Success criteria per plan §495-498:
 *   - Each tool returns a non-error response (or, for save-with-bad-source,
 *     a well-formed error response).
 *   - `list_sdks` returns at least the stdlib SDK.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { reindex } from "../../src/index/reindex.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const bin = join(repoRoot, "bin", "code-mode.ts");

describe("mcp server", () => {
  let tmpRoot: string;
  let workspaceDir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-mcp-"));
    workspaceDir = join(tmpRoot, "ws");
    const codeMode = join(workspaceDir, ".code-mode");
    const stdlibDir = join(codeMode, "sdks", "stdlib");
    const scriptsDir = join(codeMode, "scripts");
    mkdirSync(stdlibDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
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
      join(stdlibDir, "filter.ts"),
      `/**\n * Keep items where pred returns true.\n */\nexport function filter<T>(items: T[], pred: (t: T) => boolean): T[] {\n  return items.filter(pred);\n}\n`,
    );
    writeFileSync(
      join(scriptsDir, "hello.ts"),
      `/**\n * Simple greeting script — used by MCP integration test.\n */\nexport default async function main(_args: unknown) {\n  return { greeting: "hello" };\n}\n`,
    );

    // Build the initial index so list_sdks / search / query_types have data.
    await reindex(workspaceDir, {});

    // Spawn the MCP server as a subprocess and connect.
    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", bin, "mcp", "--path", workspaceDir],
      cwd: repoRoot,
    });
    client = new Client(
      { name: "code-mode-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      // ignore
    }
    try {
      await transport?.close();
    } catch {
      // ignore
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("lists the 5 expected tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_sdks", "query_types", "run", "save", "search"]);
  });

  test("list_sdks returns stdlib", async () => {
    const res = await client.callTool({ name: "list_sdks", arguments: {} });
    expect(res.isError).toBeFalsy();
    const parsed = parseJsonContent(res);
    expect(parsed.sdks).toBeArray();
    expect(parsed.sdks.some((s: { name: string }) => s.name === "stdlib")).toBe(true);
  });

  test("query_types finds 'filter'", async () => {
    const res = await client.callTool({
      name: "query_types",
      arguments: { pattern: "filter" },
    });
    expect(res.isError).toBeFalsy();
    const parsed = parseJsonContent(res);
    expect(parsed.matches.length).toBeGreaterThan(0);
    expect(parsed.matches.some((m: { name: string }) => m.name === "filter")).toBe(true);
  });

  test("search returns both scripts and symbols", async () => {
    const res = await client.callTool({
      name: "search",
      arguments: { query: "hello" },
    });
    expect(res.isError).toBeFalsy();
    const parsed = parseJsonContent(res);
    expect(parsed.results).toBeArray();
    // "hello" script is in scripts/, should show up.
    expect(parsed.results.some((r: { name: string }) => r.name === "hello")).toBe(true);
  });

  test("run executes a named script", async () => {
    const res = await client.callTool({
      name: "run",
      arguments: { mode: "named", name: "hello", argsJson: "null" },
    });
    // Structured content should contain the RunResult.
    const parsed = parseJsonContent(res);
    expect(parsed.success).toBe(true);
    expect(parsed.result).toEqual({ greeting: "hello" });
  });

  test("save persists a new script", async () => {
    const res = await client.callTool({
      name: "save",
      arguments: {
        name: "added_via_mcp",
        source: `export default async function main() { return 42; }\n`,
        intent: "persist the added_via_mcp smoke test script",
      },
    });
    expect(res.isError).toBeFalsy();
    const parsed = parseJsonContent(res);
    expect(parsed.success).toBe(true);
    expect(parsed.path).toContain("added_via_mcp.ts");
  });

  test("save rejects missing intent", async () => {
    const res = await client.callTool({
      name: "save",
      arguments: {
        name: "missing_intent",
        source: `export default async function main() { return 1; }\n`,
      },
    });
    expect(res.isError).toBe(true);
    const textBlock = (res as { content?: Array<{ type: string; text?: string }> })
      .content?.[0];
    expect(textBlock?.text).toContain("intent");
  });

  test("run inline requires intent", async () => {
    const res = await client.callTool({
      name: "run",
      arguments: {
        mode: "inline",
        source: `export default async function main() { return 1; }\n`,
      },
    });
    expect(res.isError).toBe(true);
  });

  test("run inline with intent auto-saves a substantial script", async () => {
    const substantial = [
      'import { filter } from "@/sdks/stdlib/filter";',
      "",
      "export default async function main() {",
      "  const xs = [1, 2, 3, 4, 5];",
      "  const even = filter(xs, (x) => x % 2 === 0);",
      "  return { even };",
      "}",
    ].join("\n");
    const res = await client.callTool({
      name: "run",
      arguments: {
        mode: "inline",
        source: substantial,
        intent: "filter a small array to its even elements for demo",
      },
    });
    expect(res.isError).toBeFalsy();
    const parsed = parseJsonContent(res);
    expect(parsed.success).toBe(true);
    expect(parsed.autoSaved).toBeDefined();
    expect(parsed.autoSaved.reason).toBe("saved");
    expect(parsed.autoSaved.slug).toContain("filter");
    expect(parsed.autoSaved.path).toContain("/scripts/auto/");
  });

  test("run inline dedupes identical body on second call", async () => {
    const body = [
      'import { filter } from "@/sdks/stdlib/filter";',
      "",
      "export default async function main() {",
      "  const xs = [10, 20, 30, 40];",
      "  const big = filter(xs, (x) => x > 15);",
      "  return { big };",
      "}",
    ].join("\n");
    const first = await client.callTool({
      name: "run",
      arguments: {
        mode: "inline",
        source: body,
        intent: "filter large values from an integer list",
      },
    });
    const firstParsed = parseJsonContent(first);
    expect(firstParsed.autoSaved.reason).toBe("saved");

    const second = await client.callTool({
      name: "run",
      arguments: {
        mode: "inline",
        source: body,
        intent: "completely different intent words on purpose",
      },
    });
    const secondParsed = parseJsonContent(second);
    expect(secondParsed.autoSaved.reason).toBe("deduped");
    expect(secondParsed.autoSaved.hash).toBe(firstParsed.autoSaved.hash);
    expect(secondParsed.autoSaved.path).toBe(firstParsed.autoSaved.path);
  });

  test("run inline skips auto-save for trivial source", async () => {
    const res = await client.callTool({
      name: "run",
      arguments: {
        mode: "inline",
        source: `export default async function main() { return 1; }\n`,
        intent: "smoke probe a trivial one-liner handler script",
      },
    });
    expect(res.isError).toBeFalsy();
    const parsed = parseJsonContent(res);
    expect(parsed.success).toBe(true);
    expect(parsed.autoSaved?.reason).toBe("skipped-trivial");
  });
});

function parseJsonContent(res: unknown): any {
  const content = (res as { content?: Array<{ type: string; text?: string }> })
    .content;
  const first = content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected first content block to be text");
  }
  return JSON.parse(first.text);
}
