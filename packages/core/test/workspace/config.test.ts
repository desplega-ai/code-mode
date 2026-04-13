/**
 * Tests for `packages/core/src/workspace/config.ts`.
 *
 * Covers:
 *   - Defaults when file absent.
 *   - File values override defaults.
 *   - Env overrides (CODE_MODE_MCP_BLOCK, CODE_MODE_SKIP) applied last.
 *   - Invalid file values throw.
 *   - isMcpWhitelisted prefix matching + hardcoded code-mode allowance.
 *   - CLI whitelist add/remove round-trip through saveConfig + loadConfig.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  configPath,
  defaultConfig,
  isMcpWhitelisted,
  loadConfig,
  saveConfig,
} from "../../src/workspace/config.ts";
import {
  whitelistAddHandler,
  whitelistRemoveHandler,
} from "../../src/commands/config.ts";

const ENV_KEYS = ["CODE_MODE_MCP_BLOCK", "CODE_MODE_SKIP"] as const;

function scrubEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "cm-cfg-"));
  return root;
}

function writeFileConfig(ws: string, obj: unknown): void {
  const file = configPath(ws);
  mkdirSync(join(ws, ".code-mode"), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

describe("loadConfig", () => {
  let ws: string;

  beforeEach(() => {
    scrubEnv();
    ws = makeWorkspace();
  });

  afterEach(() => {
    scrubEnv();
    rmSync(ws, { recursive: true, force: true });
  });

  test("returns defaults when config file absent", () => {
    const cfg = loadConfig(ws);
    expect(cfg).toEqual(DEFAULT_CONFIG);
    // Ensure we return a copy, not a reference.
    cfg.mcpWhitelist.push("mcp__mutation_test__");
    expect(DEFAULT_CONFIG.mcpWhitelist).not.toContain("mcp__mutation_test__");
  });

  test("file values override defaults", () => {
    writeFileConfig(ws, {
      mcpBlockMode: "block",
      mcpWhitelist: ["mcp__github__"],
      hooksEnabled: false,
    });
    const cfg = loadConfig(ws);
    expect(cfg.mcpBlockMode).toBe("block");
    expect(cfg.mcpWhitelist).toEqual(["mcp__github__"]);
    expect(cfg.hooksEnabled).toBe(false);
  });

  test("partial file merges with defaults", () => {
    writeFileConfig(ws, { mcpBlockMode: "block" });
    const cfg = loadConfig(ws);
    expect(cfg.mcpBlockMode).toBe("block");
    expect(cfg.mcpWhitelist).toEqual(DEFAULT_CONFIG.mcpWhitelist);
    expect(cfg.hooksEnabled).toBe(true);
  });

  test("CODE_MODE_MCP_BLOCK=1 forces block regardless of file", () => {
    writeFileConfig(ws, { mcpBlockMode: "hint" });
    process.env.CODE_MODE_MCP_BLOCK = "1";
    expect(loadConfig(ws).mcpBlockMode).toBe("block");
  });

  test("CODE_MODE_MCP_BLOCK=0 forces hint regardless of file", () => {
    writeFileConfig(ws, { mcpBlockMode: "block" });
    process.env.CODE_MODE_MCP_BLOCK = "0";
    expect(loadConfig(ws).mcpBlockMode).toBe("hint");
  });

  test("CODE_MODE_SKIP=1 forces hooksEnabled=false", () => {
    writeFileConfig(ws, { hooksEnabled: true });
    process.env.CODE_MODE_SKIP = "1";
    expect(loadConfig(ws).hooksEnabled).toBe(false);
  });

  test("invalid mcpBlockMode in file throws", () => {
    writeFileConfig(ws, { mcpBlockMode: "banana" });
    expect(() => loadConfig(ws)).toThrow(/invalid mcpBlockMode/);
  });

  test("invalid mcpWhitelist type in file throws", () => {
    writeFileConfig(ws, { mcpWhitelist: "not-an-array" });
    expect(() => loadConfig(ws)).toThrow(/invalid mcpWhitelist/);
  });

  test("invalid hooksEnabled type in file throws", () => {
    writeFileConfig(ws, { hooksEnabled: "yes" });
    expect(() => loadConfig(ws)).toThrow(/invalid hooksEnabled/);
  });

  test("malformed JSON in file throws", () => {
    mkdirSync(join(ws, ".code-mode"), { recursive: true });
    writeFileSync(configPath(ws), "{not json", "utf8");
    expect(() => loadConfig(ws)).toThrow(/failed to parse/);
  });
});

describe("saveConfig + round-trip", () => {
  let ws: string;

  beforeEach(() => {
    scrubEnv();
    ws = makeWorkspace();
  });

  afterEach(() => {
    scrubEnv();
    rmSync(ws, { recursive: true, force: true });
  });

  test("writes pretty-printed JSON with trailing newline", () => {
    saveConfig(ws, defaultConfig());
    const raw = readFileSync(configPath(ws), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "mcpBlockMode": "hint"');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(DEFAULT_CONFIG);
  });

  test("saveConfig then loadConfig returns the same object", () => {
    const cfg = defaultConfig();
    cfg.mcpBlockMode = "block";
    cfg.mcpWhitelist.push("mcp__github__");
    cfg.hooksEnabled = false;
    saveConfig(ws, cfg);
    const reloaded = loadConfig(ws);
    expect(reloaded).toEqual(cfg);
  });
});

describe("isMcpWhitelisted", () => {
  test("code-mode's own MCP tools always allowed", () => {
    const cfg = defaultConfig();
    cfg.mcpWhitelist = [];
    expect(
      isMcpWhitelisted("mcp__plugin_code-mode__code-mode__search", cfg),
    ).toBe(true);
    expect(isMcpWhitelisted("mcp__plugin_code-mode__anything", cfg)).toBe(true);
  });

  test("prefix match against whitelist", () => {
    const cfg = defaultConfig();
    expect(
      isMcpWhitelisted("mcp__context7__resolve-library-id", cfg),
    ).toBe(true);
    expect(
      isMcpWhitelisted("mcp__plugin_context-mode_context-mode__ctx_doctor", cfg),
    ).toBe(true);
  });

  test("no match returns false", () => {
    const cfg = defaultConfig();
    expect(isMcpWhitelisted("mcp__github__create_issue", cfg)).toBe(false);
    expect(isMcpWhitelisted("mcp__linear__list_issues", cfg)).toBe(false);
  });

  test("empty prefix entries never match", () => {
    const cfg = defaultConfig();
    cfg.mcpWhitelist = [""];
    expect(isMcpWhitelisted("mcp__whatever__foo", cfg)).toBe(false);
  });
});

describe("whitelist CLI round-trip", () => {
  let ws: string;

  beforeEach(() => {
    scrubEnv();
    ws = makeWorkspace();
    saveConfig(ws, defaultConfig());
  });

  afterEach(() => {
    scrubEnv();
    rmSync(ws, { recursive: true, force: true });
  });

  test("add then remove a prefix", async () => {
    await whitelistAddHandler("mcp__github__", { cwd: ws });
    let cfg = loadConfig(ws);
    expect(cfg.mcpWhitelist).toContain("mcp__github__");

    await whitelistRemoveHandler("mcp__github__", { cwd: ws });
    cfg = loadConfig(ws);
    expect(cfg.mcpWhitelist).not.toContain("mcp__github__");
  });

  test("add is idempotent (no duplicate)", async () => {
    await whitelistAddHandler("mcp__github__", { cwd: ws });
    await whitelistAddHandler("mcp__github__", { cwd: ws });
    const cfg = loadConfig(ws);
    const occurrences = cfg.mcpWhitelist.filter(
      (p) => p === "mcp__github__",
    ).length;
    expect(occurrences).toBe(1);
  });

  test("invalid prefix is rejected", async () => {
    const origExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;
    try {
      await expect(
        whitelistAddHandler("plainbadname", { cwd: ws }),
      ).rejects.toThrow(/process\.exit/);
      expect(exitCalls[0]).toBe(1);
    } finally {
      process.exit = origExit;
    }
    const cfg = loadConfig(ws);
    expect(cfg.mcpWhitelist).not.toContain("plainbadname");
  });
});
