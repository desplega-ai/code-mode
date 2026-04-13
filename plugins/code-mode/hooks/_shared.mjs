/**
 * Shared helpers for code-mode plugin hooks.
 *
 * IMPORTANT: This module is loaded on every PreToolUse call. Keep it
 * zero-dep (stdlib only) and do NOT import `@desplega/code-mode` — the
 * module graph + SQLite native bindings would destroy latency.
 *
 * Drift from core's `packages/core/src/workspace/config.ts#loadConfig` is
 * guarded by `packages/core/test/plugin/config-drift.test.ts`. If you
 * change config shape or precedence here, update core too (or vice versa).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Config ───────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  mcpBlockMode: "hint",
  mcpWhitelist: ["mcp__context7__", "mcp__plugin_context-mode_"],
  hooksEnabled: true,
};

function defaultConfig() {
  return {
    mcpBlockMode: DEFAULT_CONFIG.mcpBlockMode,
    mcpWhitelist: [...DEFAULT_CONFIG.mcpWhitelist],
    hooksEnabled: DEFAULT_CONFIG.hooksEnabled,
  };
}

/**
 * Load `<cwd>/.code-mode/config.json`. Missing file → defaults.
 * Applies env overrides last: CODE_MODE_MCP_BLOCK (1→block, 0→hint),
 * CODE_MODE_SKIP=1 → hooksEnabled=false.
 *
 * Semantics MUST match core's loadConfig. See config-drift.test.ts.
 *
 * Unlike core, malformed JSON here falls back to defaults rather than
 * throwing — a hook must never fail the tool call it's inspecting.
 * Invalid *values* (bad mcpBlockMode, bad types) also fall back silently
 * for the same reason. The drift test writes valid configs only, so
 * parity is preserved on the happy path.
 */
export function readConfig(cwd) {
  const cfg = defaultConfig();
  const file = join(cwd, ".code-mode", "config.json");

  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw && typeof raw === "object") {
        if (
          raw.mcpBlockMode === "hint" ||
          raw.mcpBlockMode === "block"
        ) {
          cfg.mcpBlockMode = raw.mcpBlockMode;
        }
        if (
          Array.isArray(raw.mcpWhitelist) &&
          raw.mcpWhitelist.every((x) => typeof x === "string")
        ) {
          cfg.mcpWhitelist = [...raw.mcpWhitelist];
        }
        if (typeof raw.hooksEnabled === "boolean") {
          cfg.hooksEnabled = raw.hooksEnabled;
        }
      }
    } catch {
      // Malformed JSON — fall through to defaults. Hooks must not throw.
    }
  }

  const mcpBlock = process.env.CODE_MODE_MCP_BLOCK;
  if (mcpBlock === "1") cfg.mcpBlockMode = "block";
  else if (mcpBlock === "0") cfg.mcpBlockMode = "hint";

  if (process.env.CODE_MODE_SKIP === "1") cfg.hooksEnabled = false;

  return cfg;
}

/**
 * Returns true iff `toolName` should bypass the code-mode MCP hint/block.
 * `mcp__plugin_code-mode_*` is hardcoded-allowed; otherwise passes iff
 * `toolName` starts with any non-empty prefix in `cfg.mcpWhitelist`.
 */
export function isMcpWhitelisted(toolName, cfg) {
  if (toolName.startsWith("mcp__plugin_code-mode_")) return true;
  for (const prefix of cfg.mcpWhitelist) {
    if (!prefix || prefix.length === 0) continue;
    if (toolName.startsWith(prefix)) return true;
  }
  return false;
}

// ─── Dedup state ──────────────────────────────────────────────────────

function dedupPath(sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(tmpdir(), `code-mode-hooks-${safe}.json`);
}

export function readDedup(sessionId) {
  const file = dedupPath(sessionId);
  if (!existsSync(file)) return { seenTools: {} };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && raw.seenTools && typeof raw.seenTools === "object") {
      return { seenTools: raw.seenTools };
    }
  } catch {
    // ignore, treat as empty
  }
  return { seenTools: {} };
}

export function writeDedup(sessionId, state) {
  const file = dedupPath(sessionId);
  try {
    writeFileSync(file, JSON.stringify(state), "utf8");
  } catch {
    // ignore write failures — dedup is best-effort
  }
}

// ─── Inline-exec detection ────────────────────────────────────────────

/**
 * Soft-block Bash commands that shell out to node/bun/python/ruby/perl
 * with inline code flags or heredoc-fed scripts. These are exactly the
 * throwaway-TypeScript pattern code-mode exists to replace.
 */
export const INLINE_EXEC_REGEXES = [
  /(?:^|[;&|]\s*)(?:node|bun|deno)\s+(?:eval|-e|--eval|-p|--print)\b/,
  /(?:^|[;&|]\s*)python3?\s+-c\b/,
  /(?:^|[;&|]\s*)ruby\s+-e\b/,
  /(?:^|[;&|]\s*)perl\s+-e\b/,
  /(?:node|python3?|bun)\s*<<<\s*['"]/,
  /(?:node|python3?|bun)\s*<<\s*['"]?EOF/,
];

export function isInlineExec(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  for (const re of INLINE_EXEC_REGEXES) {
    if (re.test(command)) return true;
  }
  return false;
}

// ─── Message templates ────────────────────────────────────────────────

export const WEBFETCH_HINT = `code-mode tip: before calling WebFetch, consider the stdlib \`fetch\` helper via code-mode.

It has AbortController-based timeout, 5xx/network retries with exponential backoff, and typed JSON parsing. Copy-pasteable:

  mcp__plugin_code-mode_code-mode__run({
    source: "import { getJson } from '@/sdks/stdlib/fetch';\\nexport default async () => getJson<unknown>('https://example.com/api.json');"
  })

Escape hatch: set CODE_MODE_SKIP=1 to silence all code-mode hooks.`;

export const BASH_GENERIC_HINT = `code-mode tip: for multi-step data transforms (parse JSON, reshape, filter, fuzzy-match, render as a table), prefer a saved code-mode script over a shell pipeline. \`mcp__plugin_code-mode_code-mode__search\` first, then \`__save\` when you've built something reusable.

Escape hatch: CODE_MODE_SKIP=1.`;

export function bashInlineExecReason(command) {
  return `code-mode: \`${truncate(command, 80)}\` looks like inline-exec (node/bun/python/ruby/perl -e, -c, or heredoc-fed script). This is exactly the throwaway-TypeScript pattern code-mode replaces.

Action: call \`mcp__plugin_code-mode_code-mode__save\` with the script and a kebab-case name, then \`__run\` it. You get typecheck, reuse across sessions, and the PostToolUse reindex picks it up automatically.

If you genuinely need this one-off, approve the tool call to proceed, or set CODE_MODE_SKIP=1 for the session.`;
}

export function mcpHintContext(toolName) {
  return `code-mode tip: \`${toolName}\` is not in your MCP whitelist.

If this task can be done with HTTP / shell / filesystem / data transforms, prefer writing a code-mode script using stdlib helpers in \`.code-mode/sdks/stdlib/\` (\`fetch\`, \`grep\`, \`glob\`, \`table\`, \`filter\`, \`flatten\`, \`fuzzy-match\`):

  mcp__plugin_code-mode_code-mode__run({ source: "..." })
  # or save+reuse:
  mcp__plugin_code-mode_code-mode__save({ name: "...", source: "..." })

\`mcp__plugin_code-mode_code-mode__search\` only finds *existing* saved scripts — use it before authoring new ones.

If this MCP tool is fine and you don't want this hint again:

  code-mode config whitelist add <prefix>    # e.g. mcp__github__
  # or, for a one-shot session bypass:
  CODE_MODE_SKIP=1 claude ...

To tighten the default from hint → block: \`code-mode config set mcpBlockMode block\`.`;
}

export function mcpBlockReason(toolName) {
  return `code-mode: \`${toolName}\` is not whitelisted and mcpBlockMode=block.

If this task can be done with HTTP / shell / filesystem / data transforms,
write a code-mode script instead:

  mcp__plugin_code-mode_code-mode__run({ source: "..." })
  # or save+reuse:
  mcp__plugin_code-mode_code-mode__save({ name: "...", source: "..." })

Stdlib helpers in .code-mode/sdks/stdlib/: fetch, grep, glob, table, filter,
flatten, fuzzy-match. Check for existing scripts with
mcp__plugin_code-mode_code-mode__search first (search only finds *existing*
saved scripts — don't give up if it returns nothing).

If the MCP is fine and you don't want this denied:
  code-mode config whitelist add <prefix>    # e.g. ${guessPrefix(toolName)}
  # or for one session:
  CODE_MODE_MCP_BLOCK=0 claude ...
  # or bypass code-mode entirely:
  CODE_MODE_SKIP=1 claude ...`;
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function guessPrefix(toolName) {
  // mcp__github__create_issue → mcp__github__
  const m = /^(mcp__[^_]+(?:-[^_]+)*__)/.exec(toolName);
  return m ? m[1] : "mcp__<server>__";
}
