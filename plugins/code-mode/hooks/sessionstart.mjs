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

if (process.env.CODE_MODE_SKIP === "1") {
  process.stdout.write("{}");
  process.exit(0);
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

const additionalContext = `code-mode routing guidance:

- Before writing throwaway TypeScript (inline snippets, scratch scripts, one-off transforms), call \`mcp__plugin_code-mode_code-mode__search\` first to check whether a saved script already solves the task. Reuse beats reinvention.
- Before reaching for \`WebFetch\`, consider running the stdlib \`fetch\` helper via \`mcp__plugin_code-mode_code-mode__run\`. It has retries, timeout via AbortController, and typed JSON parsing built-in — strictly more capable than \`WebFetch\` for structured API work.
- After writing a useful script, call \`mcp__plugin_code-mode_code-mode__save\` with a kebab-case \`name\` so future sessions can find it. The PostToolUse reindex hook handles the rest automatically.
- When an MCP tool is unavailable or blocked (see \`mcpBlockMode\` in \`.code-mode/config.json\`), consider whether a code-mode script using stdlib helpers (\`fetch\`, \`grep\`, \`glob\`, \`table\`, \`filter\`, \`flatten\`, \`fuzzy-match\`) can do the same job. Write inline with \`__run\` or save it with \`__save\` for reuse — don't give up just because \`__search\` returns nothing (it only finds existing scripts).
- Available stdlib helpers (already seeded by \`code-mode init\` under \`.code-mode/sdks/stdlib/\`): \`fetch\`, \`grep\`, \`glob\`, \`fuzzy-match\`, \`table\`, \`filter\`, \`flatten\`. Query their signatures via \`mcp__plugin_code-mode_code-mode__query_types\` or search by keyword with \`__search\`.

Escape hatch: set \`CODE_MODE_SKIP=1\` to bypass all code-mode hooks for the session.`;

const output = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
  },
};

process.stdout.write(JSON.stringify(output));
