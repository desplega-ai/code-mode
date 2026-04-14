/**
 * Drift guard — asserts that `plugins/code-mode/hooks/_shared.mjs`
 * `readConfig` produces the same normalised CodeModeConfig as core's
 * `loadConfig` across representative config states.
 *
 * The hook duplicates a minimal config reader (no dep on
 * @desplega/code-mode, latency-sensitive). This test catches schema
 * drift at CI time, before it reaches a user's PreToolUse call.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultConfig,
  loadConfig,
  saveConfig,
  type CodeModeConfig,
} from "../../src/workspace/config.ts";
import { isMcpWhitelisted as coreIsMcpWhitelisted } from "../../src/workspace/config.ts";

const SHARED_PATH = resolve(
  import.meta.dir,
  "../../../..",
  "plugins/code-mode/hooks/_shared.mjs",
);

interface SharedModule {
  readConfig: (cwd: string) => CodeModeConfig;
  isMcpWhitelisted: (toolName: string, cfg: CodeModeConfig) => boolean;
}

async function loadShared(): Promise<SharedModule> {
  // Cache-bust across test runs (import.meta caches; file is .mjs so
  // repeated imports in bun reuse the module; we only need one import).
  return (await import(SHARED_PATH)) as unknown as SharedModule;
}

const ENV_KEYS = ["CODE_MODE_MCP_BLOCK", "CODE_MODE_SKIP"] as const;

function scrubEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "cm-drift-"));
}

describe("config drift: _shared.mjs readConfig vs core loadConfig", () => {
  let ws: string;

  beforeEach(() => {
    scrubEnv();
    ws = makeWorkspace();
  });

  afterEach(() => {
    scrubEnv();
    rmSync(ws, { recursive: true, force: true });
  });

  test("no file → both return defaults", async () => {
    const shared = await loadShared();
    const coreCfg = loadConfig(ws);
    const hookCfg = shared.readConfig(ws);
    expect(hookCfg).toEqual(coreCfg);
  });

  test("defaults written via saveConfig → parity", async () => {
    saveConfig(ws, defaultConfig());
    const shared = await loadShared();
    expect(shared.readConfig(ws)).toEqual(loadConfig(ws));
  });

  test("mcpBlockMode=block → parity", async () => {
    const cfg = defaultConfig();
    cfg.mcpBlockMode = "block";
    saveConfig(ws, cfg);
    const shared = await loadShared();
    expect(shared.readConfig(ws)).toEqual(loadConfig(ws));
  });

  test("custom whitelist with extra prefix → parity", async () => {
    const cfg = defaultConfig();
    cfg.mcpWhitelist = [...cfg.mcpWhitelist, "mcp__github__", "mcp__linear__"];
    saveConfig(ws, cfg);
    const shared = await loadShared();
    expect(shared.readConfig(ws)).toEqual(loadConfig(ws));
  });

  test("hooksEnabled=false → parity", async () => {
    const cfg = defaultConfig();
    cfg.hooksEnabled = false;
    saveConfig(ws, cfg);
    const shared = await loadShared();
    expect(shared.readConfig(ws)).toEqual(loadConfig(ws));
  });

  test("CODE_MODE_MCP_BLOCK=1 env override → parity (both land on block)", async () => {
    saveConfig(ws, defaultConfig());
    process.env.CODE_MODE_MCP_BLOCK = "1";
    const shared = await loadShared();
    const coreCfg = loadConfig(ws);
    const hookCfg = shared.readConfig(ws);
    expect(coreCfg.mcpBlockMode).toBe("block");
    expect(hookCfg).toEqual(coreCfg);
  });

  test("CODE_MODE_MCP_BLOCK=0 env override → parity (both land on hint)", async () => {
    const cfg = defaultConfig();
    cfg.mcpBlockMode = "block";
    saveConfig(ws, cfg);
    process.env.CODE_MODE_MCP_BLOCK = "0";
    const shared = await loadShared();
    const coreCfg = loadConfig(ws);
    const hookCfg = shared.readConfig(ws);
    expect(coreCfg.mcpBlockMode).toBe("hint");
    expect(hookCfg).toEqual(coreCfg);
  });

  test("CODE_MODE_SKIP=1 env override → parity (both hooksEnabled=false)", async () => {
    saveConfig(ws, defaultConfig());
    process.env.CODE_MODE_SKIP = "1";
    const shared = await loadShared();
    const coreCfg = loadConfig(ws);
    const hookCfg = shared.readConfig(ws);
    expect(coreCfg.hooksEnabled).toBe(false);
    expect(hookCfg).toEqual(coreCfg);
  });

  test("all overrides combined → parity", async () => {
    const cfg = defaultConfig();
    cfg.mcpBlockMode = "hint";
    cfg.mcpWhitelist = ["mcp__custom__"];
    cfg.hooksEnabled = true;
    saveConfig(ws, cfg);
    process.env.CODE_MODE_MCP_BLOCK = "1";
    process.env.CODE_MODE_SKIP = "1";
    const shared = await loadShared();
    expect(shared.readConfig(ws)).toEqual(loadConfig(ws));
  });
});

describe("config drift: isMcpWhitelisted parity", () => {
  test("code-mode's own tool passes in both (marketplace shape)", async () => {
    const shared = await loadShared();
    const cfg = defaultConfig();
    cfg.mcpWhitelist = [];
    const tool = "mcp__plugin_code-mode_code-mode__search";
    expect(shared.isMcpWhitelisted(tool, cfg)).toBe(
      coreIsMcpWhitelisted(tool, cfg),
    );
    expect(shared.isMcpWhitelisted(tool, cfg)).toBe(true);
  });

  test("code-mode's own tool passes in both (bare .mcp.json shape)", async () => {
    const shared = await loadShared();
    const cfg = defaultConfig();
    cfg.mcpWhitelist = [];
    // Regression guard: this shape is what the internal bench and the
    // external MCP-Bench adapter produce. Both forms must self-exempt
    // identically in hook and core.
    for (const tool of [
      "mcp__code-mode__run",
      "mcp__code-mode__search",
      "mcp__code-mode__save",
    ]) {
      expect(shared.isMcpWhitelisted(tool, cfg)).toBe(
        coreIsMcpWhitelisted(tool, cfg),
      );
      expect(shared.isMcpWhitelisted(tool, cfg)).toBe(true);
    }
  });

  test("code-mode-look-alike server is NOT self-exempted", async () => {
    const shared = await loadShared();
    const cfg = defaultConfig();
    cfg.mcpWhitelist = [];
    const tool = "mcp__code-mode-clone__search";
    expect(shared.isMcpWhitelisted(tool, cfg)).toBe(
      coreIsMcpWhitelisted(tool, cfg),
    );
    expect(shared.isMcpWhitelisted(tool, cfg)).toBe(false);
  });

  test("default whitelist prefix matches in both", async () => {
    const shared = await loadShared();
    const cfg = defaultConfig();
    const cases = [
      "mcp__context7__resolve-library-id",
      "mcp__plugin_context-mode_context-mode__ctx_doctor",
      "mcp__github__create_issue",
      "mcp__linear__list_issues",
    ];
    for (const tool of cases) {
      expect(shared.isMcpWhitelisted(tool, cfg)).toBe(
        coreIsMcpWhitelisted(tool, cfg),
      );
    }
  });

  test("empty-string prefix treated the same in both", async () => {
    const shared = await loadShared();
    const cfg = defaultConfig();
    cfg.mcpWhitelist = [""];
    const tool = "mcp__whatever__x";
    expect(shared.isMcpWhitelisted(tool, cfg)).toBe(
      coreIsMcpWhitelisted(tool, cfg),
    );
    expect(shared.isMcpWhitelisted(tool, cfg)).toBe(false);
  });

  test("custom prefix matches in both", async () => {
    const shared = await loadShared();
    const cfg = defaultConfig();
    cfg.mcpWhitelist = ["mcp__github__"];
    const tool = "mcp__github__create_issue";
    expect(shared.isMcpWhitelisted(tool, cfg)).toBe(
      coreIsMcpWhitelisted(tool, cfg),
    );
    expect(shared.isMcpWhitelisted(tool, cfg)).toBe(true);
  });
});
