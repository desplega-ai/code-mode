/**
 * `execScript` — the type-safety gate + subprocess runner.
 *
 * Flow:
 *   1. Load the entry into a ts-morph `Project` (plus transitive imports).
 *   2. Typecheck. If diagnostics present, return `{ success: false, diagnostics }`
 *      without spawning.
 *   3. Else, spawn `bun -e <loader>` inside a `sh -c 'ulimit -v N -t M; exec ...'`
 *      wrapper (POSIX). Wall-clock enforced via `AbortSignal.timeout()`.
 *   4. Parse the sentinel-delimited serialized result from stdout; everything
 *      else is captured into `logs`.
 *
 * Reasons returned (see `RunReason`):
 *   - 'ok'      : loader printed the sentinel and exited 0
 *   - 'timeout' : AbortSignal fired
 *   - 'memory'  : POSIX signal 9 (SIGKILL) or nonzero exit with typical ulimit pattern
 *   - 'cpu'     : POSIX SIGXCPU (24) — ulimit -t exceeded
 *   - 'crash'   : any other nonzero exit / no sentinel
 */

import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import type { Project, SourceFile } from "ts-morph";
import { loadProject } from "../analysis/project.ts";
import { typecheckFile, type Diagnostic } from "../analysis/typecheck.ts";
import { emitLoaderSource, RESULT_SENTINEL } from "./loader.ts";
import {
  DEFAULT_LIMITS,
  resolveLimits,
  supportsShellLimits,
  truncateOutput,
  type RunLimits,
  type RunLimitsInput,
} from "./limits.ts";

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
}

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

  // ── Spawn ──────────────────────────────────────────────────────────────
  return spawnLoader({ entryAbs, argsJson, limits, started });
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

// ────────────────────────────────────────────────────────────────── spawn ──

interface SpawnInputs {
  entryAbs: string;
  argsJson: string;
  limits: RunLimits;
  started: number;
}

async function spawnLoader(input: SpawnInputs): Promise<RunResult> {
  const { entryAbs, argsJson, limits, started } = input;
  const loaderSource = emitLoaderSource(
    pathToFileURL(entryAbs).href,
    Buffer.from(argsJson, "utf8").toString("base64"),
  );

  let cmd: string[];
  if (supportsShellLimits()) {
    // NOTE: ulimit -v is in KB, -t in seconds. On macOS `ulimit -v` is a no-op
    // for the shell itself but is still honoured by child processes on Linux.
    // We still set it because tests on Linux CI depend on it.
    const memKb = limits.maxMemoryMb * 1024;
    const shellCmd =
      `ulimit -v ${memKb} 2>/dev/null; ulimit -t ${limits.maxCpuSec} 2>/dev/null; ` +
      `exec bun -e "$CODE_MODE_LOADER"`;
    cmd = ["sh", "-c", shellCmd];
  } else {
    // Windows MVP: skip ulimit. The caller is expected to have logged a warning.
    cmd = ["bun", "-e", loaderSource];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        ...process.env,
        CODE_MODE_LOADER: loaderSource,
      },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return {
      success: false,
      reason: "crash",
      error: `spawn failed: ${(e as Error).message}`,
      limits,
      durationMs: Date.now() - started,
    };
  }

  let stdoutBuf: Uint8Array = new Uint8Array(0);
  let stderrBuf: Uint8Array = new Uint8Array(0);

  const readAll = async (stream: ReadableStream<Uint8Array> | null | undefined): Promise<Uint8Array> => {
    if (!stream) return new Uint8Array(0);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const cap = limits.maxOutputBytes + 1024; // allow marker overhead
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total > cap) {
          // Keep reading to drain the stream, but we'll truncate later.
        }
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  };

  let exitCode: number;
  let timedOut = false;
  try {
    const results = await Promise.all([
      readAll(proc.stdout as ReadableStream<Uint8Array>),
      readAll(proc.stderr as ReadableStream<Uint8Array>),
    ]);
    stdoutBuf = results[0];
    stderrBuf = results[1];
    exitCode = await proc.exited;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (controller.signal.aborted || /abort/i.test(msg)) {
      timedOut = true;
      exitCode = -1;
    } else {
      clearTimeout(timer);
      return {
        success: false,
        reason: "crash",
        error: `spawn/wait failed: ${msg}`,
        limits,
        durationMs: Date.now() - started,
      };
    }
  }
  clearTimeout(timer);

  if (controller.signal.aborted) {
    timedOut = true;
  }

  // Search for the sentinel in the full raw stdout first so we can extract
  // the result even when the log volume exceeds the cap. We then truncate
  // ONLY the pre-sentinel log portion.
  const fullStdout = new TextDecoder().decode(stdoutBuf);
  const sentinelIdx = fullStdout.lastIndexOf(RESULT_SENTINEL);
  let result: unknown = null;
  let preSentinelRaw = fullStdout;
  let parseErr: string | null = null;
  if (sentinelIdx >= 0) {
    preSentinelRaw = fullStdout.slice(0, sentinelIdx).replace(/\n?$/, "");
    const rest = fullStdout.slice(sentinelIdx + RESULT_SENTINEL.length);
    const newlineIdx = rest.indexOf("\n");
    const jsonPart = newlineIdx >= 0 ? rest.slice(0, newlineIdx) : rest;
    try {
      result = JSON.parse(jsonPart);
    } catch (e) {
      parseErr = `failed to parse result JSON: ${(e as Error).message}`;
    }
  }

  const preSentinelBytes = new TextEncoder().encode(preSentinelRaw);
  const stdoutTrunc = truncateOutput(preSentinelBytes, limits.maxOutputBytes);
  const stderrTrunc = truncateOutput(stderrBuf, limits.maxOutputBytes);

  const logsText = combineLogs(stdoutTrunc.text, stderrTrunc.text);
  const logsTruncated = stdoutTrunc.truncated || stderrTrunc.truncated;

  if (timedOut) {
    return {
      success: false,
      reason: "timeout",
      logs: logsText,
      logsTruncated,
      exitCode,
      durationMs: Date.now() - started,
      limits,
    };
  }

  // Detect CPU / memory kills from exit signals when available (Bun surfaces
  // -SIG via negative exit on POSIX).
  if (exitCode === 137 || exitCode === -9) {
    return {
      success: false,
      reason: "memory",
      logs: logsText,
      logsTruncated,
      exitCode,
      durationMs: Date.now() - started,
      limits,
    };
  }
  if (exitCode === 152 || exitCode === -24) {
    return {
      success: false,
      reason: "cpu",
      logs: logsText,
      logsTruncated,
      exitCode,
      durationMs: Date.now() - started,
      limits,
    };
  }

  if (exitCode !== 0 || sentinelIdx < 0) {
    // If stderr looks like an OOM / allocation failure, classify as memory.
    if (
      /Out of memory|allocation failed|JavaScript heap out of memory|FATAL ERROR: .*Allocation/i.test(
        stderrTrunc.text,
      )
    ) {
      return {
        success: false,
        reason: "memory",
        logs: logsText,
        logsTruncated,
        exitCode,
        durationMs: Date.now() - started,
        limits,
      };
    }
    return {
      success: false,
      reason: sentinelIdx < 0 && exitCode === 0 ? "loader" : "crash",
      error: parseErr ?? `process exited ${exitCode} without sentinel`,
      logs: logsText,
      logsTruncated,
      exitCode,
      durationMs: Date.now() - started,
      limits,
    };
  }

  if (parseErr) {
    return {
      success: false,
      reason: "loader",
      error: parseErr,
      logs: logsText,
      logsTruncated,
      exitCode,
      durationMs: Date.now() - started,
      limits,
    };
  }

  return {
    success: true,
    result,
    logs: logsText,
    logsTruncated,
    exitCode,
    durationMs: Date.now() - started,
    reason: "ok",
    limits,
  };
}

function combineLogs(stdoutRest: string, stderr: string): string {
  const parts: string[] = [];
  if (stdoutRest.trim().length > 0) parts.push(stdoutRest);
  if (stderr.trim().length > 0) parts.push(stderr);
  return parts.join("\n");
}

export { DEFAULT_LIMITS };
