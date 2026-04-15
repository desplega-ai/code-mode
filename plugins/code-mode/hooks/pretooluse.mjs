#!/usr/bin/env node
// PreToolUse dispatcher for code-mode plugin.
// Dispatched on tool_name from stdin. Handles:
//   - WebFetch   → allow + hint pointing at stdlib fetch helper
//   - Bash       → allow + generic hint, OR ask + reason for inline-exec
//   - mcp__*     → allow / allow+hint / deny based on workspace config
//
// Never throws. Never blocks for longer than a config file read +
// tiny JSON write. Respects CODE_MODE_SKIP=1 and a per-session dedup
// state file in $TMPDIR so each tool only gets hinted once.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  readConfig,
  isMcpWhitelisted,
  CODE_MODE_SELF_TOOL_RE,
  readDedup,
  writeDedup,
  isInlineExec,
  webfetchHint,
  bashGenericHint,
  bashInlineExecReason,
  mcpHintContext,
  mcpBlockReason,
} from "./_shared.mjs";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj ?? {}));
}

function allowWithContext(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext,
    },
  };
}

function askWithReason(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  };
}

function denyWithReason(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Return a passive reuse hint when the agent is about to run an inline
 * script and `<workspace>/.code-mode/scripts/auto/` contains files whose
 * slugs share tokens with the agent's `intent`. Dependency-free: we
 * compare filename slugs against intent keywords rather than opening
 * the SQLite FTS index, which would force a better-sqlite3 dep into
 * the hook runtime (Node, not Bun).
 *
 * The match heuristic is deliberately simple:
 *   - split the intent on whitespace
 *   - drop tokens <4 characters (stopword-ish filter)
 *   - a script matches if its slug contains ≥1 non-trivial token
 *
 * This misses semantic matches with different vocabulary, but catches
 * the common case of similar-wording intents — which is exactly what
 * auto-save produces on its own for repeat work.
 *
 * Returns the hint string (to inject into additionalContext) or null if
 * no files match / the auto dir doesn't exist yet.
 */
function codeModeReuseHint(cwd, intent) {
  const autoDir = join(cwd, ".code-mode", "scripts", "auto");
  if (!existsSync(autoDir)) return null;

  let files;
  try {
    files = readdirSync(autoDir).filter((f) => f.endsWith(".ts"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const tokens = intent
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]+/g, ""))
    .filter((t) => t.length >= 4);
  if (tokens.length === 0) return null;

  const matches = [];
  for (const file of files) {
    const slug = file.slice(0, -3); // drop .ts
    if (tokens.some((t) => slug.includes(t))) {
      matches.push(slug);
      if (matches.length >= 5) break;
    }
  }
  if (matches.length === 0) return null;

  const lines = [
    "code-mode: found auto-saved script(s) whose name matches keywords from your `intent`:",
    ...matches.map((m) => `  - auto/${m}`),
    "",
    "If one of them already does what you need, call `run` with `mode: 'named', name: 'auto/<slug>'`",
    "instead of re-authoring the script. Reuse beats reinvention.",
    "",
    "Otherwise proceed — this is a passive hint, not a block.",
  ];
  return lines.join("\n");
}

async function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
    // If stdin is a TTY (no piped input), end immediately.
    if (process.stdin.isTTY) resolve("");
  });
}

async function main() {
  if (process.env.CODE_MODE_SKIP === "1") {
    emit({});
    return;
  }

  const raw = await readStdin();
  let payload;
  try {
    payload = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch {
    // Malformed stdin — never fail the tool call.
    emit({});
    return;
  }

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const toolInput = payload.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input
    : {};
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();

  if (!toolName) {
    emit({});
    return;
  }

  // Dedup: same tool_name already seen in this session → silent pass.
  //
  // This is correct for `hint` mode (don't spam the same hint over and
  // over) and for non-mcp tools (Bash, WebFetch) where dedup just
  // reduces noise. It is WRONG for `mcp__*` tools in `block` mode —
  // if we silent-pass a prior-seen mcp tool, the agent successfully
  // calls it after ignoring one denial per tool name, which defeats
  // block enforcement entirely.
  //
  // Fix: for mcp tools, read config up-front and skip the dedup
  // short-circuit when the tool would be denied. Self-exempt
  // (`mcp__code-mode__*`) and whitelisted tools still silent-pass
  // via the existing branches below.
  const dedup = readDedup(sessionId);
  if (dedup.seenTools[toolName]) {
    let dedupShortCircuit = true;
    if (toolName.startsWith("mcp__") && !CODE_MODE_SELF_TOOL_RE.test(toolName)) {
      const cfg = readConfig(cwd);
      if (cfg.mcpBlockMode === "block" && !isMcpWhitelisted(toolName, cfg)) {
        dedupShortCircuit = false;
      }
    }
    if (dedupShortCircuit) {
      emit({});
      return;
    }
  }

  // Compute decision before marking seen — a deny response should still
  // record the tool so repeat attempts don't spam.
  let decision;

  if (toolName === "WebFetch") {
    decision = allowWithContext(webfetchHint(cwd));
  } else if (toolName === "Bash") {
    const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
    if (isInlineExec(cmd)) {
      decision = askWithReason(bashInlineExecReason(cmd, cwd));
    } else {
      decision = allowWithContext(bashGenericHint(cwd));
    }
  } else if (toolName.startsWith("mcp__")) {
    // Own tools (both shapes): check for auto-save reuse opportunity on
    // `run` with inline/stdin mode, otherwise silent pass. No dedup bump
    // so the hint re-fires on repeat invocations (agent picks up on it).
    if (CODE_MODE_SELF_TOOL_RE.test(toolName)) {
      if (toolName.endsWith("__run")) {
        const mode = typeof toolInput.mode === "string" ? toolInput.mode : "";
        const intent = typeof toolInput.intent === "string" ? toolInput.intent : "";
        if ((mode === "inline" || mode === "stdin") && intent.trim()) {
          const hint = codeModeReuseHint(cwd, intent);
          if (hint) {
            emit(allowWithContext(hint));
            return;
          }
        }
      }
      emit({});
      return;
    }
    const cfg = readConfig(cwd);
    if (isMcpWhitelisted(toolName, cfg)) {
      // Whitelisted: silent pass, no dedup bump.
      emit({});
      return;
    }
    if (cfg.mcpBlockMode === "block") {
      decision = denyWithReason(mcpBlockReason(toolName, cwd));
    } else {
      decision = allowWithContext(mcpHintContext(toolName, cwd));
    }
  } else {
    // Not a tool we route on. Silent pass, no dedup bump.
    emit({});
    return;
  }

  // Record dedup *after* deciding, *before* emitting.
  dedup.seenTools[toolName] = Date.now();
  writeDedup(sessionId, dedup);

  emit(decision);
}

main().catch(() => {
  // Never fail the tool call.
  emit({});
});
