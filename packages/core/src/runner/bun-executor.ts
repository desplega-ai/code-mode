/**
 * Default `Executor` implementation: spawns `bun -e <loader>` in a POSIX
 * shell wrapper with `ulimit` applied. On non-POSIX platforms we fall back
 * to a direct `bun -e` spawn (ulimit is a best-effort signal, not a
 * correctness guarantee).
 *
 * Extracted from the original `execScript` in `exec.ts` so runtimes are
 * swappable without touching the typecheck gate or the MCP handlers.
 */

import { pathToFileURL } from "node:url";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { emitLoaderSource, RESULT_SENTINEL } from "./loader.ts";
import {
  supportsShellLimits,
  truncateOutput,
  type RunLimits,
} from "./limits.ts";
import type { RunResult } from "./exec.ts";
import type { Executor, ExecutorInput } from "./executor.ts";

/**
 * Map POSIX signal names to their numeric code so we can surface them
 * through the `exitCode` path. `proc.on('exit')` in node gives a signal
 * *name*, but downstream logic keys off numbers (SIGKILL=9, SIGXCPU=24).
 */
const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGABRT: 6,
};

export class BunExecutor implements Executor {
  readonly name = "bun";

  async execute(input: ExecutorInput): Promise<RunResult> {
    return spawnLoader({
      entryAbs: input.entryAbs,
      argsJson: input.argsJson,
      limits: input.limits,
      started: Date.now(),
    });
  }
}

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

  // Surface non-Abort spawn errors (ENOENT, EACCES, etc.) through the
  // regular crash path rather than crashing the CLI process.
  let spawnError: Error | null = null;

  let proc: ChildProcessByStdio<null, Readable, Readable>;
  try {
    proc = spawn(cmd[0]!, cmd.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CODE_MODE_LOADER: loaderSource,
      },
      signal: controller.signal,
    });
    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).name !== "AbortError") {
        spawnError = err;
      }
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

  const readAll = async (stream: Readable | null | undefined): Promise<Uint8Array> => {
    if (!stream) return new Uint8Array(0);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  };

  const exited: Promise<number> = new Promise((resolveExit) => {
    proc.on("exit", (code, signal) => {
      // Convention: unix signal gets mapped to 128+signum so we can still
      // surface SIGXCPU (24) / SIGKILL (9) through the exit-code path.
      if (code !== null) resolveExit(code);
      else if (signal) {
        const sigNum = SIGNAL_NUMBERS[signal as NodeJS.Signals] ?? 1;
        resolveExit(128 + sigNum);
      } else resolveExit(-1);
    });
  });

  let exitCode: number;
  let timedOut = false;
  try {
    const results = await Promise.all([
      readAll(proc.stdout),
      readAll(proc.stderr),
    ]);
    stdoutBuf = results[0];
    stderrBuf = results[1];
    exitCode = await exited;
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

  // TS narrows `spawnError` to `never` because the only assignment lives in
  // a proc.on('error', ...) callback that control-flow analysis can't see.
  const capturedSpawnError = spawnError as Error | null;
  if (capturedSpawnError && !timedOut) {
    return {
      success: false,
      reason: "crash",
      error: `spawn failed: ${capturedSpawnError.message}`,
      limits,
      durationMs: Date.now() - started,
    };
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
