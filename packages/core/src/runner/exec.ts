/**
 * `execScript` — the type-safety gate in front of script execution.
 *
 * Flow:
 *   1. Load the entry into a ts-morph `Project` (plus transitive imports).
 *   2. Typecheck. If diagnostics present, return `{ success: false, diagnostics }`
 *      without delegating.
 *   3. Else, hand `{ entryAbs, argsJson, limits }` to the configured
 *      `Executor` (default: `BunExecutor`). Runtimes are pluggable — swap in
 *      a Docker/Worker/Deno implementation without touching the typecheck path.
 *
 * Reasons returned (see `RunReason`):
 *   - 'ok'      : loader printed the sentinel and exited 0
 *   - 'timeout' : AbortSignal fired
 *   - 'memory'  : POSIX signal 9 (SIGKILL) or nonzero exit with typical ulimit pattern
 *   - 'cpu'     : POSIX SIGXCPU (24) — ulimit -t exceeded
 *   - 'crash'   : any other nonzero exit / no sentinel
 */

import { resolve as resolvePath } from "node:path";
import type { Project, SourceFile } from "ts-morph";
import { loadProject } from "../analysis/project.ts";
import { typecheckFile, type Diagnostic } from "../analysis/typecheck.ts";
import {
  DEFAULT_LIMITS,
  resolveLimits,
  type RunLimits,
  type RunLimitsInput,
} from "./limits.ts";
import type { Executor } from "./executor.ts";
import { BunExecutor } from "./bun-executor.ts";

export type RunReason = "ok" | "timeout" | "memory" | "cpu" | "crash";

export interface RunResultOk {
  success: true;
  result: unknown;
  logs: string;
  logsTruncated: boolean;
  exitCode: number;
  durationMs: number;
  reason: "ok";
  limits: RunLimits;
  /**
   * Populated by the MCP `run` handler (not `execScript` itself) when the
   * inline/stdin source was auto-persisted under `.code-mode/scripts/auto/`.
   * `null` when auto-save was skipped (trivial script, invalid intent, etc.).
   */
  autoSaved?: AutoSaveInfo | null;
}

export interface AutoSaveInfo {
  reason: "saved" | "deduped" | "skipped-trivial" | "skipped-invalid-intent";
  /** Present on `saved` and `deduped`. */
  slug?: string;
  /** Absolute path. Present on `saved` and `deduped`. */
  path?: string;
  /** Content hash used for dedupe. */
  hash: string;
  /** Details for skipped cases. */
  detail?: string;
}

export interface RunResultFail {
  success: false;
  diagnostics?: Diagnostic[];
  /** Present when the failure is from execution, not typecheck. */
  logs?: string;
  logsTruncated?: boolean;
  exitCode?: number;
  signal?: string | null;
  durationMs?: number;
  reason?: RunReason | "argscap" | "typecheck" | "loader";
  error?: string;
  limits?: RunLimits;
}

export type RunResult = RunResultOk | RunResultFail;

export interface ExecOptions {
  workspaceDir: string;
  /** Absolute path to the entry .ts file. */
  entry: string;
  /** JSON-encoded argument object passed to main(args). Defaults to "null". */
  argsJson?: string;
  limits?: RunLimitsInput;
  /**
   * Optional: skip spawning (for tests that only want the typecheck branch).
   */
  typecheckOnly?: boolean;
  /**
   * Optional pre-loaded project. If omitted, one is loaded from
   * `<workspaceDir>/.code-mode/tsconfig.json`.
   */
  project?: Project;
  /**
   * When true, recurse into referenced source files for typechecking. Default
   * true. Depth-capped at 16 to avoid pathological graphs.
   */
  typecheckTransitive?: boolean;
  /**
   * Override the runtime. Defaults to `BunExecutor` — a module-level singleton
   * is reused across calls.
   */
  executor?: Executor;
}

const defaultExecutor: Executor = new BunExecutor();

export async function execScript(opts: ExecOptions): Promise<RunResult> {
  const started = Date.now();
  const limits = resolveLimits(opts.limits);
  const entryAbs = resolvePath(opts.entry);
  const argsJson = opts.argsJson ?? "null";

  // ── Args size guard ────────────────────────────────────────────────────
  const argsBytes = Buffer.byteLength(argsJson, "utf8");
  if (argsBytes > limits.maxArgsBytes) {
    return {
      success: false,
      reason: "argscap",
      error: `argsJson is ${argsBytes} bytes, exceeds limit ${limits.maxArgsBytes}`,
      limits,
      durationMs: Date.now() - started,
    };
  }

  // ── Typecheck ──────────────────────────────────────────────────────────
  let project: Project;
  try {
    project = opts.project ?? loadProject(opts.workspaceDir);
  } catch (e) {
    return {
      success: false,
      reason: "typecheck",
      error: `failed to load ts-morph Project: ${(e as Error).message}`,
      limits,
      durationMs: Date.now() - started,
    };
  }

  // Make sure the entry is in the project. If the workspace's tsconfig
  // doesn't include it (e.g. --inline file outside .code-mode/scripts), add it.
  let sourceFile: SourceFile | undefined = project.getSourceFile(entryAbs);
  if (!sourceFile) {
    try {
      sourceFile = project.addSourceFileAtPath(entryAbs);
    } catch (e) {
      return {
        success: false,
        reason: "typecheck",
        error: `failed to load entry: ${(e as Error).message}`,
        limits,
        durationMs: Date.now() - started,
      };
    }
  }

  const diagnostics = collectDiagnostics(project, sourceFile, {
    transitive: opts.typecheckTransitive !== false,
  });
  if (diagnostics.length > 0) {
    return {
      success: false,
      reason: "typecheck",
      diagnostics,
      limits,
      durationMs: Date.now() - started,
    };
  }

  if (opts.typecheckOnly) {
    return {
      success: true,
      result: null,
      logs: "",
      logsTruncated: false,
      exitCode: 0,
      durationMs: Date.now() - started,
      reason: "ok",
      limits,
    };
  }

  // ── Delegate to executor ───────────────────────────────────────────────
  const executor = opts.executor ?? defaultExecutor;
  return executor.execute({ entryAbs, argsJson, limits });
}

// ──────────────────────────────────────────────────────── typecheck helpers ──

function collectDiagnostics(
  project: Project,
  entry: SourceFile,
  { transitive }: { transitive: boolean },
): Diagnostic[] {
  const files: SourceFile[] = [entry];
  if (transitive) {
    const seen = new Set<string>([entry.getFilePath()]);
    const stack: SourceFile[] = [entry];
    let steps = 0;
    const maxSteps = 16;
    while (stack.length > 0 && steps < maxSteps) {
      steps += 1;
      const cur = stack.pop()!;
      let refs: SourceFile[] = [];
      try {
        refs = cur.getReferencedSourceFiles();
      } catch {
        refs = [];
      }
      for (const ref of refs) {
        const p = ref.getFilePath();
        if (seen.has(p)) continue;
        // Skip node_modules / lib.d.ts — those are not our concern and blow
        // up the typecheck budget.
        if (p.includes("/node_modules/")) continue;
        if (p.endsWith(".d.ts")) continue;
        seen.add(p);
        files.push(ref);
        stack.push(ref);
      }
    }
  }
  const out: Diagnostic[] = [];
  for (const sf of files) {
    for (const d of typecheckFile(project, sf.getFilePath())) {
      // Only propagate errors — warnings/suggestions shouldn't block execution.
      if (d.severity === "error") out.push(d);
    }
  }
  return out;
}

export { DEFAULT_LIMITS };
