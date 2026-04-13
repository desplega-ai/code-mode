/**
 * `code-mode config` — read/write `.code-mode/config.json`.
 *
 * Subcommands:
 *   - get <key>              key ∈ { mcpBlockMode | hooksEnabled | mcpWhitelist }
 *   - set <key> <value>      with validation
 *   - whitelist add <prefix>
 *   - whitelist remove <prefix>
 *   - whitelist list
 *
 * All commands accept `--cwd <path>` (defaults to `process.cwd()`).
 */

import { resolve } from "node:path";
import {
  loadConfig,
  saveConfig,
  type CodeModeConfig,
} from "../workspace/config.ts";

export interface BaseConfigOptions {
  cwd?: string;
}

const VALID_KEYS = ["mcpBlockMode", "hooksEnabled", "mcpWhitelist"] as const;
type ConfigKey = (typeof VALID_KEYS)[number];

// Loose shape — matches e.g. mcp__context7__, mcp__plugin_code-mode_,
// mcp__github_, etc. Rejects obvious junk like plain "github" or paths.
const WHITELIST_PREFIX_RE = /^mcp__[a-z0-9_-]+(__[a-z0-9_-]+)*__?$/;

function resolveCwd(opts: BaseConfigOptions): string {
  return resolve(opts.cwd ?? process.cwd());
}

function fail(msg: string): never {
  console.error(`[code-mode config] ${msg}`);
  process.exit(1);
}

function assertKey(key: string): asserts key is ConfigKey {
  if (!(VALID_KEYS as readonly string[]).includes(key)) {
    fail(`unknown key "${key}" (expected one of: ${VALID_KEYS.join(", ")})`);
  }
}

export async function getHandler(
  key: string,
  opts: BaseConfigOptions,
): Promise<void> {
  assertKey(key);
  const cfg = loadConfig(resolveCwd(opts));
  const value = cfg[key];
  if (Array.isArray(value)) {
    console.log(JSON.stringify(value));
  } else {
    console.log(String(value));
  }
}

export async function setHandler(
  key: string,
  value: string,
  opts: BaseConfigOptions,
): Promise<void> {
  assertKey(key);
  if (key === "mcpWhitelist") {
    fail(
      `use 'code-mode config whitelist add/remove' to mutate the whitelist`,
    );
  }

  const cwd = resolveCwd(opts);
  const cfg = loadConfig(cwd);
  const next: CodeModeConfig = {
    ...cfg,
    mcpWhitelist: [...cfg.mcpWhitelist],
  };

  if (key === "mcpBlockMode") {
    if (value !== "hint" && value !== "block") {
      fail(`invalid mcpBlockMode: "${value}" (expected "hint" or "block")`);
    }
    next.mcpBlockMode = value;
  } else if (key === "hooksEnabled") {
    if (value !== "true" && value !== "false") {
      fail(`invalid hooksEnabled: "${value}" (expected "true" or "false")`);
    }
    next.hooksEnabled = value === "true";
  }

  saveConfig(cwd, next);
  console.log(`[code-mode config] set ${key}=${value}`);
}

export async function whitelistAddHandler(
  prefix: string,
  opts: BaseConfigOptions,
): Promise<void> {
  if (!WHITELIST_PREFIX_RE.test(prefix)) {
    fail(
      `invalid whitelist prefix: "${prefix}" (expected shape like "mcp__github__" or "mcp__plugin_foo_")`,
    );
  }
  const cwd = resolveCwd(opts);
  const cfg = loadConfig(cwd);
  if (cfg.mcpWhitelist.includes(prefix)) {
    console.log(`[code-mode config] whitelist already contains "${prefix}"`);
    return;
  }
  cfg.mcpWhitelist.push(prefix);
  saveConfig(cwd, cfg);
  console.log(`[code-mode config] whitelist += "${prefix}"`);
}

export async function whitelistRemoveHandler(
  prefix: string,
  opts: BaseConfigOptions,
): Promise<void> {
  const cwd = resolveCwd(opts);
  const cfg = loadConfig(cwd);
  const idx = cfg.mcpWhitelist.indexOf(prefix);
  if (idx < 0) {
    console.log(`[code-mode config] whitelist did not contain "${prefix}"`);
    return;
  }
  cfg.mcpWhitelist.splice(idx, 1);
  saveConfig(cwd, cfg);
  console.log(`[code-mode config] whitelist -= "${prefix}"`);
}

export async function whitelistListHandler(
  opts: BaseConfigOptions,
): Promise<void> {
  const cfg = loadConfig(resolveCwd(opts));
  if (cfg.mcpWhitelist.length === 0) {
    console.log("(empty)");
    return;
  }
  for (const prefix of cfg.mcpWhitelist) {
    console.log(prefix);
  }
}
