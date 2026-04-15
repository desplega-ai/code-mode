#!/usr/bin/env node
// SessionStart hook for code-mode plugin.
// Emits additionalContext that steers the agent toward code-mode
// search/run/save + stdlib helpers before reaching for throwaway
// TypeScript or WebFetch.
//
// Behavior:
//   - CODE_MODE_SKIP=1 -> emit {} and exit (full bypass).
//   - Best-effort cleanup of stale $TMPDIR/code-mode-hooks-*.json
//     state files older than 24h (wrapped in try/catch).
//   - Emit static routing block via stdout JSON.
//
// Latency target: <50ms (static text, no subprocess, no DB read).

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanSdks,
  renderSdkSummary,
  listSavedScripts,
  codeModeToolPrefix,
} from "./_shared.mjs";

if (process.env.CODE_MODE_SKIP === "1") {
  process.stdout.write("{}");
  process.exit(0);
}

function readSessionCwd() {
  // SessionStart hook receives `cwd` on stdin, but we don't want to block
  // on stdin for latency. Claude Code spawns the hook with PWD set to the
  // session cwd, so process.cwd() is reliable here.
  return process.cwd();
}

function buildSdkBlock(cwd) {
  try {
    const sdks = scanSdks(cwd);
    const body = renderSdkSummary(sdks);
    if (!body) return null;
    const scripts = listSavedScripts(cwd, { limit: 10 });
    const scriptsLine =
      scripts.total === 0
        ? null
        : scripts.total <= 10
          ? `Saved scripts: ${scripts.names.join(", ")}`
          : `Saved scripts: ${scripts.total} total — most recent: ${scripts.recent.join(", ")} (use __search to find more)`;
    const p = codeModeToolPrefix(null, cwd);
    const parts = [
      "code-mode SDKs available:",
      body,
      "",
      `Invoke any export via \`${p}run\` with TS source that imports from \`@/sdks/stdlib/...\` or \`@/sdks/.generated/<server>\`.`,
    ];
    if (scriptsLine) parts.push("", scriptsLine);
    return parts.join("\n");
  } catch {
    return null;
  }
}

// Best-effort cleanup of stale dedup-state files (>24h old).
// Never let this fail the hook.
try {
  const dir = tmpdir();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith("code-mode-hooks-") || !entry.endsWith(".json")) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) unlinkSync(full);
    } catch {
      // ignore per-file errors
    }
  }
} catch {
  // ignore cleanup errors entirely
}

const sessionCwd = readSessionCwd();
const sdkBlock = buildSdkBlock(sessionCwd);
const p = codeModeToolPrefix(null, sessionCwd);

const routingBody = `code-mode routing guidance:

- Every call to \`${p}run\`, \`${p}save\`, \`${p}search\`, and \`${p}query_types\` now accepts (and for \`run\`/\`save\` REQUIRES) an \`intent\` field: one short sentence (≥4 words) describing why you're making the call. Intents are logged to \`.code-mode/intent-log.jsonl\` for session telemetry; for \`run\` they also drive the auto-save slug.
- \`${p}run\` inline/stdin: every SUCCESSFUL run is auto-persisted to \`.code-mode/scripts/auto/<slug>.ts\`, where \`<slug>\` is derived from your \`intent\`. The returned \`autoSaved\` field shows the reason (\`saved\`, \`deduped\`, \`skipped-trivial\`) and the path. Next time you need the same behavior, call \`run\` with \`mode: 'named', name: 'auto/<slug>'\` — or call \`${p}search\` with keywords from your intent first.
- Before writing throwaway TypeScript, call \`${p}search\` first to check whether a saved script (including auto-saved ones under \`scripts/auto/\`) already solves the task. Reuse beats reinvention. The pretooluse hook also injects a passive hint when your \`intent\` keywords match an existing auto-save — if you see one, prefer \`mode: 'named'\`.
- Before reaching for \`WebFetch\`, consider running the stdlib \`fetch\` helper via \`${p}run\`. It has retries, timeout via AbortController, and typed JSON parsing built-in — strictly more capable than \`WebFetch\` for structured API work.
- Use \`${p}save\` only for hand-curated scripts you want under \`.code-mode/scripts/<name>.ts\` (not \`scripts/auto/\`). Successful inline runs get auto-saved already; explicit \`save\` is for promoting something worth keeping.
- When an MCP tool is unavailable or blocked (see \`mcpBlockMode\` in \`.code-mode/config.json\`), consider whether a code-mode script using stdlib helpers (\`fetch\`, \`grep\`, \`glob\`, \`table\`, \`filter\`, \`flatten\`, \`fuzzy-match\`) can do the same job. Write inline with \`${p}run\` + intent — don't give up just because \`${p}search\` returns nothing.
- Available stdlib helpers (already seeded by \`code-mode init\` under \`.code-mode/sdks/stdlib/\`): \`fetch\`, \`grep\`, \`glob\`, \`fuzzy-match\`, \`table\`, \`filter\`, \`flatten\`. Query their signatures via \`${p}query_types\` or search by keyword with \`${p}search\`.

Escape hatch: set \`CODE_MODE_SKIP=1\` to bypass all code-mode hooks for the session.`;

const additionalContext = sdkBlock
  ? `${sdkBlock}\n\n${routingBody}`
  : routingBody;

const output = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
  },
};

process.stdout.write(JSON.stringify(output));
