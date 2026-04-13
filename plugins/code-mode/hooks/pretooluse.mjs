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

import {
  readConfig,
  isMcpWhitelisted,
  readDedup,
  writeDedup,
  isInlineExec,
  WEBFETCH_HINT,
  BASH_GENERIC_HINT,
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
  const dedup = readDedup(sessionId);
  if (dedup.seenTools[toolName]) {
    emit({});
    return;
  }

  // Compute decision before marking seen — a deny response should still
  // record the tool so repeat attempts don't spam.
  let decision;

  if (toolName === "WebFetch") {
    decision = allowWithContext(WEBFETCH_HINT);
  } else if (toolName === "Bash") {
    const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
    if (isInlineExec(cmd)) {
      decision = askWithReason(bashInlineExecReason(cmd));
    } else {
      decision = allowWithContext(BASH_GENERIC_HINT);
    }
  } else if (toolName.startsWith("mcp__")) {
    // Own tools: silent pass, no dedup bump (avoid cluttering state).
    if (toolName.startsWith("mcp__plugin_code-mode_")) {
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
      decision = denyWithReason(mcpBlockReason(toolName));
    } else {
      decision = allowWithContext(mcpHintContext(toolName));
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
