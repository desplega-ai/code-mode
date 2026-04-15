/**
 * MCP tool handler: `run`.
 *
 * Three modes:
 *   - `named`  → run `.code-mode/scripts/<name>.ts`.
 *   - `inline` → write `source` to a tempfile, run it.
 *   - `stdin`  → alias of `inline`, kept for CLI symmetry.
 *
 * Delegates to the same `execScript` used by `code-mode run`.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { execScript, type RunResult } from "../../runner/exec.ts";
import { resolveWorkspacePaths } from "../../index/reindex.ts";
import { updateUsageCounter } from "../../commands/run.ts";
import { normalizeScriptSource } from "../../analysis/normalize.ts";

export type RunMode = "named" | "inline" | "stdin";

export interface RunArgs {
  mode: RunMode;
  name?: string;
  source?: string;
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
    // inline or stdin — both expect `source`.
    if (!args.source) {
      throw new Error(`run: \`source\` is required when mode='${args.mode}'`);
    }
    const tmp = mkdtempSync(join(tmpdir(), "code-mode-mcp-run-"));
    entry = join(tmp, "inline.ts");
    // Pass codeModeDir so `@/...` import specifiers get rewritten to
    // absolute paths. Without this, Bun walks up from `inline.ts` in
    // the tmpdir looking for our tsconfig's paths alias and doesn't
    // find it, so `@/sdks/.generated/<server>` fails to resolve.
    const normalized = normalizeScriptSource(args.source, {
      codeModeDir: ws.codeModeDir,
    });
    writeFileSync(entry, normalized.source, "utf8");
    cleanup = () => {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };
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
    return result;
  } finally {
    cleanup?.();
  }
}
