/**
 * Execution limits for `code-mode run`.
 *
 * Limits are applied in two places:
 *   - `AbortSignal.timeout()` wired to `Bun.spawn({ signal })` for wall-clock.
 *   - `ulimit -v <kb> -t <sec>` via a POSIX `sh -c` wrapper for memory/CPU caps.
 *
 * Windows is intentionally MVP-unsupported for `ulimit`; callers log a warning
 * and skip those limits (`applyShellLimits: false`).
 *
 * Every exec records the resolved limits in the result so callers can tell a
 * timeout apart from a memory kill.
 */

export interface RunLimits {
  /** Wall-clock timeout in milliseconds. */
  timeoutMs: number;
  /** Max virtual memory in megabytes (ulimit -v). */
  maxMemoryMb: number;
  /** Max CPU seconds (ulimit -t). */
  maxCpuSec: number;
  /** Max captured stdout+stderr bytes. */
  maxOutputBytes: number;
  /** Max argsJson length in bytes (rejected pre-spawn). */
  maxArgsBytes: number;
}

export interface RunLimitsInput {
  timeoutMs?: number;
  maxMemoryMb?: number;
  maxCpuSec?: number;
  maxOutputBytes?: number;
  maxArgsBytes?: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  timeoutMs: 30_000,
  maxMemoryMb: 512,
  maxCpuSec: 60,
  maxOutputBytes: 1_000_000,
  maxArgsBytes: 256 * 1024,
};

export const MAX_LIMITS = {
  timeoutMs: 300_000,
  maxMemoryMb: 2048,
};

/**
 * Clamp any caller-supplied overrides against hard ceilings and fill in
 * defaults for anything omitted.
 */
export function resolveLimits(input?: RunLimitsInput): RunLimits {
  const src = input ?? {};
  const timeoutMs = clamp(
    src.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    1,
    MAX_LIMITS.timeoutMs,
  );
  const maxMemoryMb = clamp(
    src.maxMemoryMb ?? DEFAULT_LIMITS.maxMemoryMb,
    1,
    MAX_LIMITS.maxMemoryMb,
  );
  const maxCpuSec = clamp(
    src.maxCpuSec ?? DEFAULT_LIMITS.maxCpuSec,
    1,
    600,
  );
  const maxOutputBytes = clamp(
    src.maxOutputBytes ?? DEFAULT_LIMITS.maxOutputBytes,
    1_024,
    50_000_000,
  );
  const maxArgsBytes = clamp(
    src.maxArgsBytes ?? DEFAULT_LIMITS.maxArgsBytes,
    128,
    10_000_000,
  );
  return { timeoutMs, maxMemoryMb, maxCpuSec, maxOutputBytes, maxArgsBytes };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * True on POSIX-ish platforms where `sh -c 'ulimit ...'` works.
 */
export function supportsShellLimits(): boolean {
  return process.platform !== "win32";
}

/**
 * Truncate a Buffer to at most `cap` bytes, returning `{ text, truncated }`.
 * Truncation marker is appended as UTF-8 to the returned text when applicable.
 */
export function truncateOutput(buf: Uint8Array, cap: number): {
  text: string;
  truncated: boolean;
  originalBytes: number;
} {
  const originalBytes = buf.byteLength;
  if (originalBytes <= cap) {
    return {
      text: new TextDecoder().decode(buf),
      truncated: false,
      originalBytes,
    };
  }
  const slice = buf.subarray(0, cap);
  const text = new TextDecoder().decode(slice) + "\n[truncated]";
  return { text, truncated: true, originalBytes };
}
