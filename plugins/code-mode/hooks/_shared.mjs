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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

export function mcpBlockReason(toolName, cwd) {
  const specific = cwd ? buildTypedSdkSnippet(toolName, cwd) : null;
  if (specific) {
    return `code-mode: \`${toolName}\` is blocked (mcpBlockMode=block).

Use the typed SDK via __run:

  mcp__plugin_code-mode_code-mode__run({
    source: \`
${indent(specific.snippet, "      ")}
    \`
  })
${specific.siblings ? `\nOther ${specific.server} tools: ${specific.siblings}\n` : ""}
If you don't want this denied: \`code-mode config whitelist add ${guessPrefix(toolName)}\` or run with CODE_MODE_MCP_BLOCK=0.`;
  }
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

function indent(s, pad) {
  return s.split("\n").map((l) => (l.length > 0 ? pad + l : l)).join("\n");
}

// ─── SDK enumeration (pure regex, no TS compiler) ─────────────────────

const SDK_SCAN_MAX_FILES_PER_SDK = 40;
const SDK_SUMMARY_MAX_LINES_PER_SDK = 10;
const ARGS_SIGNATURE_MAX_CHARS = 60;

/**
 * Scan `.code-mode/sdks/stdlib/` and `.code-mode/sdks/.generated/*.ts`,
 * returning a compact summary of each SDK's top-level exports.
 *
 * Return shape:
 *   [ { name: "stdlib", exports: ["getJson(url, init?)", "grep(pattern, options?)", ...] },
 *     { name: "dbhub",  exports: ["executeSql({ sql: string })", ...] } ]
 *
 * Parsing is intentionally regex-based: the hook is on a hot path and we
 * won't pay the cost of spawning ts-morph on every SessionStart. Misparses
 * fall back to just the function name, which is still useful.
 */
export function scanSdks(cwd) {
  const root = join(cwd, ".code-mode", "sdks");
  if (!existsSync(root)) return [];
  const out = [];

  // Stdlib: one file per helper, each file exports one canonical function +
  // maybe some types.
  const stdlibDir = join(root, "stdlib");
  if (existsSync(stdlibDir)) {
    const entries = listTsFiles(stdlibDir);
    const stdlibExports = [];
    for (const f of entries.slice(0, SDK_SCAN_MAX_FILES_PER_SDK)) {
      const fns = parseExportedFunctions(f);
      // For stdlib files we prefer the function whose name matches the filename
      // stem (that's the canonical export); fall back to the first.
      const stem = fileStem(f).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      const preferred = fns.find((fn) => fn.name === stem) ?? fns[0];
      if (preferred) stdlibExports.push(preferred);
    }
    if (stdlibExports.length > 0) {
      out.push({
        name: "stdlib",
        exports: stdlibExports.map(formatExport),
      });
    }
  }

  // Generated: one file per MCP server under .generated/<slug>.ts.
  const genDir = join(root, ".generated");
  if (existsSync(genDir)) {
    let files;
    try {
      files = readdirSync(genDir).filter(
        (f) => f.endsWith(".ts") && !f.startsWith("_"),
      );
    } catch {
      files = [];
    }
    for (const f of files) {
      const full = join(genDir, f);
      const fns = parseExportedFunctions(full);
      if (fns.length === 0) continue;
      out.push({
        name: fileStem(full),
        exports: fns.map(formatExport),
      });
    }
  }
  return out;
}

/**
 * Look up a specific MCP tool in the generated SDK directory.
 *
 * Given `mcp__dbhub__execute_sql` + a workspace cwd, find
 * `.code-mode/sdks/.generated/dbhub.ts` and extract the exported wrapper
 * that matches `execute_sql` (camel-cased). Returns null when not found.
 *
 * Return shape:
 *   { server, slug, importPath, fnName, argsInterface, argsBody, siblingFns }
 */
export function findGeneratedTool(toolName, cwd) {
  const m = /^mcp__([^_][\s\S]*?)__([\s\S]+)$/.exec(toolName);
  // Fall back to a simple `mcp__<server>__<tool>` split: server is the chunk
  // between `mcp__` and the next `__`, tool is the rest.
  if (!m) return null;
  const parts = toolName.split("__");
  if (parts.length < 3) return null;
  const server = parts[1];
  const tool = parts.slice(2).join("__");
  if (!server || !tool) return null;

  const slug = server.replace(/[^A-Za-z0-9_\-]/g, "_");
  const file = join(cwd, ".code-mode", "sdks", ".generated", `${slug}.ts`);
  if (!existsSync(file)) return null;

  const fns = parseExportedFunctions(file);
  if (fns.length === 0) return null;
  const wantFn = toCamelIdent(tool);
  const target = fns.find((f) => f.name === wantFn);
  if (!target) return null;

  return {
    server,
    slug,
    importPath: `@/sdks/.generated/${slug}`,
    fnName: target.name,
    argsInterface: target.argsTypeName,
    argsBody: target.argsBody,
    argsSignature: target.argsSignature,
    siblingFns: fns.filter((f) => f.name !== target.name).map(formatExport),
  };
}

/**
 * Build a runnable __run snippet for a denied MCP tool. Returns null when
 * no generated SDK is found for the tool (caller falls back to generic).
 */
export function buildTypedSdkSnippet(toolName, cwd) {
  const hit = findGeneratedTool(toolName, cwd);
  if (!hit) return null;
  const args = hit.argsSignature && hit.argsSignature !== "{}" ? "{ /* ...args */ }" : "";
  const lines = [
    `import { ${hit.fnName} } from "${hit.importPath}";`,
    `const result = await ${hit.fnName}(${args});`,
    `console.log(JSON.stringify(result));`,
  ];
  return {
    server: hit.server,
    snippet: lines.join("\n"),
    siblings:
      hit.siblingFns.length > 0
        ? hit.siblingFns.slice(0, 4).join(", ") +
          (hit.siblingFns.length > 4 ? `, … (${hit.siblingFns.length - 4} more)` : "")
        : null,
  };
}

/**
 * Read top-level `export async function` / `export function` declarations
 * plus any matching `export interface <Name>Args { ... }` bodies.
 *
 * Deliberately simple: we parse top-level lines only, and pair `FooArgs` with
 * any function whose first param is typed as `FooArgs`. Edge cases (fancy
 * generics, multi-line signatures) fall back to an empty arg body.
 */
function parseExportedFunctions(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  // Collect `export interface <Name> { ... }` bodies (top-level only).
  const interfaces = {};
  // Match `export interface FooArgs { ... }` where `{...}` can be single-line
  // or multi-line. We use a simple brace-balance from the `{` after the name.
  const ifaceRe = /^export interface (\w+)[^{]*\{/gm;
  let m;
  while ((m = ifaceRe.exec(text)) !== null) {
    const openIdx = m.index + m[0].length - 1; // index of `{`
    const closeIdx = matchBrace(text, openIdx);
    if (closeIdx < 0) continue;
    interfaces[m[1]] = text.slice(openIdx + 1, closeIdx);
  }

  const fns = [];
  // Match `export [async] function name(...arg sig line...): ...` — signature
  // may span multiple lines until the opening `{` of the body. We capture
  // everything from `(` to the matching top-level `)` using a simple
  // paren-counter on the truncated head of the file.
  // Match `export [async] function <name>` and skip any generic type parameter
  // block (can contain nested `<>` like `<T extends Record<string, unknown>>`)
  // by looking for the first `(` after the name on the same logical declaration.
  const fnHeaderRe = /^export (?:async )?function (\w+)\b/gm;
  while ((m = fnHeaderRe.exec(text)) !== null) {
    const name = m[1];
    const openIdx = findParamOpenParen(text, m.index + m[0].length);
    if (openIdx < 0) continue;
    const closeIdx = matchParen(text, openIdx);
    if (closeIdx < 0) {
      fns.push({ name, argsTypeName: null, argsBody: null, argsSignature: "" });
      continue;
    }
    const paramList = text.slice(openIdx + 1, closeIdx).trim();
    const argsTypeName = findArgsTypeName(paramList);
    const argsBody = argsTypeName && interfaces[argsTypeName] ? interfaces[argsTypeName] : null;
    fns.push({
      name,
      argsTypeName,
      argsBody,
      argsSignature: abbreviateParamList(paramList, argsBody),
    });
  }
  return fns;
}

/**
 * Starting just after the function name, find the `(` that opens the param
 * list — skipping any `<...>` generic block (which may contain nested `<>`).
 */
function findParamOpenParen(text, startIdx) {
  let i = startIdx;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return -1;
  if (text[i] === "<") {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "<") depth++;
      else if (ch === ">") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    while (i < text.length && /\s/.test(text[i])) i++;
  }
  return text[i] === "(" ? i : -1;
}

function matchParen(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findArgsTypeName(paramList) {
  // Look for `args: FooArgs` or just `FooArgs` as the sole param type.
  const m = /:\s*(\w+Args)\b/.exec(paramList);
  return m ? m[1] : null;
}

/**
 * Produce a short, stable abbreviation of the function's first param for the
 * SessionStart summary. We prefer `{ foo, bar }` shape when we can extract
 * property names from the interface body; otherwise fall back to the raw param
 * list (truncated).
 */
function abbreviateParamList(paramList, argsBody) {
  if (argsBody) {
    // Extract top-level property names from the interface body. The body is
    // the raw contents between `{` and `}` of `export interface FooArgs { ... }`.
    const props = [];
    // Match top-level props in the interface body. We rely on a simple depth
    // counter to skip nested braces (unions with inline object types, etc.).
    const topLevel = flattenTopLevel(argsBody);
    const propRe = /(?:^|[;,\n])\s*(?:\/\*\*[^]*?\*\/\s*)?(\w+)(\??)\s*:/g;
    let m;
    // Seed match at position 0 so the first prop (which may not be preceded by
    // a separator) is matched.
    const seeded = " " + topLevel;
    while ((m = propRe.exec(seeded)) !== null) {
      if (!props.includes(m[1] + (m[2] || ""))) {
        props.push(m[1] + (m[2] || ""));
      }
      if (props.length >= 4) break;
    }
    if (props.length > 0) return `{ ${props.join(", ")} }`;
  }
  const single = paramList.replace(/\s+/g, " ").trim();
  if (single.length === 0) return "";
  return single.length > ARGS_SIGNATURE_MAX_CHARS
    ? single.slice(0, ARGS_SIGNATURE_MAX_CHARS - 1) + "…"
    : single;
}

/**
 * Strip nested `{...}`, `[...]`, `(...)` blocks from a string, leaving only
 * top-level syntax. Used to simplify interface-body property extraction so
 * nested object literals / generics / function types don't leak identifiers.
 */
function flattenTopLevel(s) {
  let depth = 0;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{" || ch === "[" || ch === "(") {
      if (depth === 0) out += " ";
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

function formatExport(fn) {
  return fn.argsSignature ? `${fn.name}(${fn.argsSignature})` : `${fn.name}()`;
}

function listTsFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
      .map((f) => join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

function fileStem(fullPath) {
  const base = fullPath.split("/").pop() ?? fullPath;
  return base.endsWith(".ts") ? base.slice(0, -3) : base;
}

function toCamelIdent(s) {
  const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return s;
  const head = parts[0].toLowerCase();
  const tail = parts
    .slice(1)
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase());
  return head + tail.join("");
}

/**
 * Render a compact per-SDK block for SessionStart additionalContext.
 * Caps each SDK's visible exports at `SDK_SUMMARY_MAX_LINES_PER_SDK`.
 */
export function renderSdkSummary(sdks) {
  if (sdks.length === 0) return null;
  const nameWidth = Math.min(
    10,
    sdks.reduce((acc, s) => Math.max(acc, s.name.length + 1), 0),
  );
  const lines = [];
  for (const sdk of sdks) {
    const exports = sdk.exports;
    const shown = exports.slice(0, SDK_SUMMARY_MAX_LINES_PER_SDK);
    const rest = exports.length - shown.length;
    let rendered = shown.join(", ");
    if (rest > 0) {
      rendered += `, … (${rest} more — __query_types to explore)`;
    }
    lines.push(`  ${(sdk.name + ":").padEnd(nameWidth + 1)} ${rendered}`);
  }
  return lines.join("\n");
}

/**
 * List saved scripts under `.code-mode/scripts/**` recursively (up to a small
 * cap). Returns `{ names: string[], total: number }`.
 */
export function listSavedScripts(cwd, { limit = 10 } = {}) {
  const root = join(cwd, ".code-mode", "scripts");
  if (!existsSync(root)) return { names: [], total: 0, recent: [] };
  const all = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        // Relative path from the scripts root, minus `.ts`.
        const rel = full.slice(root.length + 1).replace(/\\/g, "/");
        const name = rel.endsWith(".ts") ? rel.slice(0, -3) : rel;
        all.push({ name, mtimeMs });
      }
    }
  }
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    names: all.slice(0, limit).map((s) => s.name),
    recent: all.slice(0, 3).map((s) => s.name),
    total: all.length,
  };
}
