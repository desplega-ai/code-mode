/**
 * Minimal runtime abstraction for `code-mode run`.
 *
 * `code-mode` owns *what* runs: typechecked TypeScript with a sentinel-
 * delimited result and captured logs. An `Executor` implementation owns
 * *how* it runs — bun subprocess (default), Docker container, Worker
 * isolate, Deno sandbox, etc.
 *
 * Contract:
 *   - Callers (typically `execScript`) have already typechecked `entryAbs`
 *     and emitted the loader glue. The executor receives an entry path that
 *     points to a ready-to-run `.ts` file.
 *   - The executor must honour `limits` (timeout, memory, cpu, output bytes)
 *     and classify failures into the `RunReason` set.
 *   - Logs must be returned as a single string (`logs.truncated` reported
 *     separately). Structured stdout/stderr splitting is out of scope.
 */

import type { RunResult } from "./exec.ts";
import type { RunLimits } from "./limits.ts";

export interface ExecutorInput {
  /** Absolute path to the entry `.ts` file. Must exist on disk. */
  entryAbs: string;
  /** JSON-encoded argument passed to `main(args)` inside the script. */
  argsJson: string;
  /** Resolved run limits. Every `*` field is a concrete number. */
  limits: RunLimits;
}

export interface Executor {
  /** Short identifier surfaced in diagnostics and telemetry (e.g. `"bun"`). */
  readonly name: string;
  execute(input: ExecutorInput): Promise<RunResult>;
}
