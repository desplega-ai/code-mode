import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverMcpServers, parseMcpServersBlock } from "../../src/sdk-gen/config.ts";

describe("sdk-gen/config", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-sdkgen-cfg-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("parseMcpServersBlock — stdio + http + invalid entries", () => {
    const raw = {
      mcpServers: {
        good: { command: "bun", args: ["run", "server.ts"], env: { X: "1" } },
        api: { url: "https://example.com/mcp" },
        bogus: { nothing: true },
        notAnObject: 42,
      },
    };
    const { servers, errors } = parseMcpServersBlock(raw, "/fake/path");
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({
      name: "good",
      transport: "stdio",
      command: "bun",
      args: ["run", "server.ts"],
      env: { X: "1" },
    });
    expect(servers[1]).toMatchObject({ name: "api", transport: "http", url: "https://example.com/mcp" });
    expect(errors).toHaveLength(2);
  });

  test("discoverMcpServers — project .mcp.json wins over ~/.claude.json", () => {
    const ws = join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "project-command" },
          projectOnly: { command: "p-only" },
        },
      }),
    );
    const userCfg = join(tmpRoot, "claude.json");
    writeFileSync(
      userCfg,
      JSON.stringify({
        mcpServers: {
          shared: { command: "user-command" },
          userOnly: { url: "https://u.example/" },
        },
      }),
    );

    const disc = discoverMcpServers({ workspaceDir: ws, userConfigPath: userCfg });
    const byName = Object.fromEntries(disc.servers.map((s) => [s.name, s]));
    expect(byName.shared?.command).toBe("project-command");
    expect(byName.projectOnly?.command).toBe("p-only");
    expect(byName.userOnly?.url).toBe("https://u.example/");
    expect(disc.sources.length).toBe(2);
  });

  test("discoverMcpServers — explicit path wins over everything", () => {
    const ws = join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "project" } } }),
    );
    const explicit = join(tmpRoot, "explicit.json");
    writeFileSync(
      explicit,
      JSON.stringify({ mcpServers: { shared: { command: "explicit" } } }),
    );
    const disc = discoverMcpServers({
      workspaceDir: ws,
      explicitPath: explicit,
      userConfigPath: "/nonexistent",
    });
    expect(disc.servers.find((s) => s.name === "shared")?.command).toBe("explicit");
  });

  test("discoverMcpServers — missing explicit path is reported", () => {
    const ws = join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    const disc = discoverMcpServers({
      workspaceDir: ws,
      explicitPath: join(tmpRoot, "missing.json"),
      userConfigPath: "/nonexistent",
    });
    expect(disc.servers).toHaveLength(0);
    expect(disc.errors).toHaveLength(1);
    expect(disc.errors[0]!.reason).toContain("does not exist");
  });

  test("discoverMcpServers — malformed JSON records error, does not throw", () => {
    const ws = join(tmpRoot, "ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, ".mcp.json"), "{ not valid json");
    const disc = discoverMcpServers({ workspaceDir: ws, userConfigPath: "/nonexistent" });
    expect(disc.servers).toHaveLength(0);
    expect(disc.errors.some((e) => e.reason.startsWith("parse error"))).toBe(true);
  });
});
