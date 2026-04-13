/**
 * Public library surface for `@desplega/code-mode`.
 *
 * The primary distribution is the `code-mode` CLI binary; this entry point
 * exposes the execution pipeline as a library so downstream can plug in
 * custom runtimes (Docker, Worker isolates, Deno, etc.) via the `Executor`
 * interface — or reuse the source normalizer on its own.
 *
 * Marked **experimental** — this surface may change between minor versions
 * until 1.0.
 */

export { execScript, DEFAULT_LIMITS } from "./runner/exec.ts";
export type {
  RunResult,
  RunResultOk,
  RunResultFail,
  RunReason,
  ExecOptions,
} from "./runner/exec.ts";
export type { Executor, ExecutorInput } from "./runner/executor.ts";
export { BunExecutor } from "./runner/bun-executor.ts";
export type { RunLimits, RunLimitsInput } from "./runner/limits.ts";
export {
  normalizeScriptSource,
  type NormalizeResult,
} from "./analysis/normalize.ts";
