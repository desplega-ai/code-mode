/**
 * MCP tool handler: `run`.
 *
 * Three modes:
 *   - `named`  → run `.code-mode/scripts/<name>.ts`.
 *   - `inline` → write `source` to a tempfile, run it.
 *   - `stdin`  → alias of `inline`, kept for CLI symmetry.
 *
 * Intent + auto-save (inline/stdin only):
 *   `intent` is a required human-readable description of WHY the agent is
 *   running this script. On successful inline/stdin runs it drives:
 *     - `logIntent` into `.code-mode/intent-log.jsonl` (telemetry)
 *     - `writeAutoSave` into `.code-mode/scripts/auto/<slug>.ts` so later
 *       `__search` calls can surface the script by intent keywords.
 *   Named mode inherits the saved script's own description; it does not
 *   need an intent (but accepts one for log consistency).
 *
 * Delegates to the same `execScript` used by `code-mode run`.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execScript, type RunResult } from "../../runner/exec.ts";
import { resolveWorkspacePaths } from "../../index/reindex.ts";
import { updateUsageCounter } from "../../commands/run.ts";
import { normalizeScriptSource } from "../../analysis/normalize.ts";
import { writeAutoSave } from "../../analysis/auto-save.ts";
import { logIntent } from "../../analysis/intent-log.ts";
import { openDatabase } from "../../db/open.ts";
import { migrate } from "../../db/migrate.ts";

export type RunMode = "named" | "inline" | "stdin";

export interface RunArgs {
  mode: RunMode;
  name?: string;
  source?: string;
  /**
   * Required when mode='inline'|'stdin'. Drives slug generation for
   * auto-save + goes into the intent log. Accepted but optional for
   * mode='named' (the saved script already carries metadata).
   */
  intent?: string;
  argsJson?: string;
  timeoutMs?: number;
  maxMemoryMb?: number;
  maxCpuSec?: number;
  maxOutputBytes?: number;
}

export async function handleRun(
  workspaceDir: string,
  args: RunArgs,
): Promise<RunResult> {
  const ws = resolveWorkspacePaths(workspaceDir);
  let entry: string;
  let cleanup: (() => void) | undefined;
  let isInlineLike = false;
  let normalizedSource: string | undefined;

  if (args.mode === "named") {
    if (!args.name) {
      throw new Error("run: `name` is required when mode='named'");
    }
    const named = args.name.endsWith(".ts") ? args.name : `${args.name}.ts`;
    entry = isAbsolute(named) ? named : join(ws.scriptsDir, named);
    if (!existsSync(entry)) {
      throw new Error(`saved script not found: ${entry}`);
    }
  } else {
    // inline or stdin — both expect `source` + `intent`.
    if (!args.source) {
      throw new Error(`run: \`source\` is required when mode='${args.mode}'`);
    }
    if (!args.intent || !args.intent.trim()) {
      throw new Error(
        `run: \`intent\` is required when mode='${args.mode}'. ` +
          `Provide a short sentence (≥4 words) describing why you're running ` +
          `this script — it drives auto-save naming and session telemetry.`,
      );
    }
    isInlineLike = true;
    const tmp = mkdtempSync(join(tmpdir(), "code-mode-mcp-run-"));
    entry = join(tmp, "inline.ts");
    // Pass codeModeDir so `@/...` import specifiers get rewritten to
    // absolute paths. Without this, Bun walks up from `inline.ts` in
    // the tmpdir looking for our tsconfig's paths alias and doesn't
    // find it, so `@/sdks/.generated/<server>` fails to resolve.
    const normalized = normalizeScriptSource(args.source, {
      codeModeDir: ws.codeModeDir,
    });
    normalizedSource = normalized.source;
    writeFileSync(entry, normalized.source, "utf8");
    cleanup = () => {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };
  }

  // Log intent regardless of mode so the activity feed captures every call.
  if (args.intent && args.intent.trim()) {
    try {
      logIntent({
        codeModeDir: ws.codeModeDir,
        tool: "run",
        intent: args.intent.trim(),
        meta: {
          mode: args.mode,
          ...(args.mode === "named" && args.name ? { name: args.name } : {}),
        },
      });
    } catch {
      // Never fail a run because of telemetry.
    }
  }

  try {
    const result = await execScript({
      workspaceDir: ws.workspaceDir,
      entry,
      argsJson: args.argsJson ?? "null",
      limits: {
        timeoutMs: args.timeoutMs,
        maxMemoryMb: args.maxMemoryMb,
        maxCpuSec: args.maxCpuSec,
        maxOutputBytes: args.maxOutputBytes,
      },
    });

    // Mirror CLI behavior: update usage counters for saved scripts.
    if (args.mode === "named" && entry.startsWith(ws.scriptsDir)) {
      try {
        updateUsageCounter(ws.workspaceDir, entry, result.success);
      } catch {
        // ignore
      }
    }

    // Auto-save successful inline/stdin runs so the agent can retrieve
    // them later via __search. We pass the *normalized* source (post-alias
    // rewrite) so the saved file is immediately runnable by name without
    // re-normalization. DB indexing is best-effort — reindex catches up.
    if (result.success && isInlineLike && args.intent && normalizedSource) {
      try {
        const db = existsSync(ws.dbPath) ? openDatabase(ws.dbPath) : undefined;
        try {
          if (db) migrate(db);
          const saved = writeAutoSave({
            intent: args.intent.trim(),
            source: normalizedSource,
            codeModeDir: ws.codeModeDir,
            db,
          });
          (result as { autoSaved?: typeof saved }).autoSaved = saved;
        } finally {
          db?.close();
        }
      } catch {
        // Auto-save is best-effort — never fail a successful run because
        // of it. The result still reports `success: true`.
      }
    }

    return result;
  } finally {
    cleanup?.();
  }
}
