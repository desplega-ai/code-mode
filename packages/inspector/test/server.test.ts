/**
 * Server-API tests for the inspector.
 *
 * Spawns the HTTP server against a scratch workspace that points at the fake
 * MCP fixture shipped with @code-mode/core, then exercises every endpoint.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startInspectorServer, type InspectorServerHandle } from "../server/server.ts";

const FAKE_SERVER = resolve(
  __dirname,
  "..",
  "..",
  "core",
  "test",
  "fixtures",
  "fake-mcp-server.ts",
);

describe("inspector server — API endpoints", () => {
  let tmpRoot: string;
  let handle: InspectorServerHandle;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-inspector-"));
    writeFileSync(
      join(tmpRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          fake: {
            command: "bun",
            args: ["run", FAKE_SERVER],
          },
        },
      }),
    );
    handle = await startInspectorServer({
      workspaceDir: tmpRoot,
      port: 0,
      host: "127.0.0.1",
      userConfigPath: join(tmpRoot, ".nonexistent-user.json"),
    });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("GET /api/servers lists configured MCP servers", async () => {
    const r = await fetch(`${handle.url}/api/servers`).then((r) => r.json());
    expect(r.ok).toBe(true);
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0].name).toBe("fake");
    expect(r.servers[0].transport).toBe("stdio");
  });

  test("GET /api/tools/:server returns the tool list for the fake MCP", async () => {
    const r = await fetch(`${handle.url}/api/tools/fake`).then((r) => r.json());
    expect(r.ok).toBe(true);
    expect(r.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "create_issue",
      "list-labels",
      "ping",
    ]);
  }, 30_000);

  test("GET /api/tools/:server returns error for unknown server", async () => {
    const r = await fetch(`${handle.url}/api/tools/does-not-exist`).then((r) => r.json());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unknown server");
  });

  test("POST /api/invoke round-trips a tool call against the fake MCP", async () => {
    const r = await fetch(`${handle.url}/api/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server: "fake", tool: "ping", args: {} }),
    }).then((r) => r.json());
    expect(r.ok).toBe(true);
    // fake-mcp-server echoes back a structuredContent with `echoed` key.
    expect(r.result).toBeDefined();
  }, 30_000);

  test("POST /api/invoke rejects missing fields", async () => {
    const r = await fetch(`${handle.url}/api/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "ping" }),
    });
    expect(r.status).toBe(400);
  });

  test("GET /api/generated/:server returns 404 when file missing", async () => {
    const r = await fetch(`${handle.url}/api/generated/fake`);
    expect(r.status).toBe(404);
  });

  test("GET /api/generated/:server serves existing file", async () => {
    const gDir = join(tmpRoot, ".code-mode", "sdks", ".generated");
    mkdirSync(gDir, { recursive: true });
    const body = "// generated SDK\nexport const x = 1;\n";
    writeFileSync(join(gDir, "fake.ts"), body);
    const r = await fetch(`${handle.url}/api/generated/fake`).then((r) => r.json());
    expect(r.ok).toBe(true);
    expect(r.contents).toBe(body);
  });

  test("GET /api/generated rejects traversal attempts", async () => {
    const r = await fetch(`${handle.url}/api/generated/..%2Fevil`);
    expect(r.status).toBe(400);
  });

  test("GET / serves HTML shell with app.js", async () => {
    const html = await fetch(`${handle.url}/`).then((r) => r.text());
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("/app.js");
  });

  test("GET /app.js serves JS bundle", async () => {
    const resp = await fetch(`${handle.url}/app.js`);
    expect(resp.headers.get("content-type")).toContain("javascript");
    const body = await resp.text();
    expect(body).toContain("/api/servers");
  });
});
