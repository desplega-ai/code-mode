/**
 * Workspace config loader for `.code-mode/config.json`.
 *
 * Precedence (lowest → highest): defaults → file → env overrides.
 *
 * Env overrides:
 *   - `CODE_MODE_MCP_BLOCK=1` → `mcpBlockMode: "block"`
 *   - `CODE_MODE_MCP_BLOCK=0` → `mcpBlockMode: "hint"`
 *   - `CODE_MODE_SKIP=1`      → `hooksEnabled: false`
 *
 * Invalid `mcpBlockMode` in a user-provided config.json is surfaced as a
 * throw — better to fail loud than silently discard a setting the user
 * put in a file on purpose.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CodeModeConfig {
  mcpBlockMode: "hint" | "block";
  mcpWhitelist: string[];
  hooksEnabled: boolean;
}

export const DEFAULT_CONFIG: CodeModeConfig = {
  mcpBlockMode: "hint",
  mcpWhitelist: ["mcp__context7__", "mcp__plugin_context-mode_"],
  hooksEnabled: true,
};

/**
 * Path to the config file for a given workspace root.
 */
export function configPath(workspacePath: string): string {
  return join(workspacePath, ".code-mode", "config.json");
}

/**
 * Return a fresh copy of the defaults so callers can mutate safely.
 */
export function defaultConfig(): CodeModeConfig {
  return {
    mcpBlockMode: DEFAULT_CONFIG.mcpBlockMode,
    mcpWhitelist: [...DEFAULT_CONFIG.mcpWhitelist],
    hooksEnabled: DEFAULT_CONFIG.hooksEnabled,
  };
}

/**
 * Load and normalise `<workspacePath>/.code-mode/config.json`.
 *
 * - Missing file → defaults.
 * - Malformed JSON → throw.
 * - Invalid `mcpBlockMode` value → throw.
 * - Env overrides applied last.
 */
export function loadConfig(workspacePath: string): CodeModeConfig {
  const cfg = defaultConfig();
  const file = configPath(workspacePath);

  if (existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(
        `[code-mode] failed to parse ${file}: ${(err as Error).message}`,
      );
    }
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (obj.mcpBlockMode !== undefined) {
        if (obj.mcpBlockMode !== "hint" && obj.mcpBlockMode !== "block") {
          throw new Error(
            `[code-mode] invalid mcpBlockMode in ${file}: ${JSON.stringify(obj.mcpBlockMode)} (expected "hint" or "block")`,
          );
        }
        cfg.mcpBlockMode = obj.mcpBlockMode;
      }
      if (obj.mcpWhitelist !== undefined) {
        if (
          !Array.isArray(obj.mcpWhitelist) ||
          !obj.mcpWhitelist.every((x) => typeof x === "string")
        ) {
          throw new Error(
            `[code-mode] invalid mcpWhitelist in ${file}: expected string[]`,
          );
        }
        cfg.mcpWhitelist = [...obj.mcpWhitelist];
      }
      if (obj.hooksEnabled !== undefined) {
        if (typeof obj.hooksEnabled !== "boolean") {
          throw new Error(
            `[code-mode] invalid hooksEnabled in ${file}: expected boolean`,
          );
        }
        cfg.hooksEnabled = obj.hooksEnabled;
      }
    }
  }

  // Env overrides always win.
  const mcpBlock = process.env.CODE_MODE_MCP_BLOCK;
  if (mcpBlock === "1") cfg.mcpBlockMode = "block";
  else if (mcpBlock === "0") cfg.mcpBlockMode = "hint";

  if (process.env.CODE_MODE_SKIP === "1") cfg.hooksEnabled = false;

  return cfg;
}

/**
 * Serialize `cfg` to `<workspacePath>/.code-mode/config.json`.
 * Pretty-printed with 2-space indent + trailing newline.
 * Creates the `.code-mode/` directory if missing.
 */
export function saveConfig(workspacePath: string, cfg: CodeModeConfig): void {
  const file = configPath(workspacePath);
  mkdirSync(dirname(file), { recursive: true });
  const payload: CodeModeConfig = {
    mcpBlockMode: cfg.mcpBlockMode,
    mcpWhitelist: [...cfg.mcpWhitelist],
    hooksEnabled: cfg.hooksEnabled,
  };
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

/**
 * Returns true iff `toolName` should bypass the code-mode MCP hint/block.
 *
 * - `mcp__plugin_code-mode__*` is hardcoded-allowed.
 * - Otherwise passes iff `toolName` starts with any prefix in
 *   `cfg.mcpWhitelist`.
 */
export function isMcpWhitelisted(toolName: string, cfg: CodeModeConfig): boolean {
  if (toolName.startsWith("mcp__plugin_code-mode__")) return true;
  for (const prefix of cfg.mcpWhitelist) {
    if (prefix.length === 0) continue;
    if (toolName.startsWith(prefix)) return true;
  }
  return false;
}
