import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardedEnv } from "./env.ts";
import { ingestLine, newAccumulator } from "./stream.ts";
import { checkSmoke } from "./tasks.ts";
import type { RunResult, TaskDef, Variant } from "./types.ts";

export interface RunOpts {
  task: TaskDef;
  variant: Variant;
  model: string;
  rep: number;
  runId: string;
  image: string;
  /** Absolute path to seeds/generic for variant 2. */
  genericSeedsDir: string;
}

export async function runOne(opts: RunOpts): Promise<RunResult> {
  const { task, variant, model, rep, runId, image, genericSeedsDir } = opts;
  const base = newAccumulator();
  const result: RunResult = {
    task_id: task.id,
    variant,
    model,
    rep,
    run_id: runId,
    status: "ok",
    wall_ms: 0,
    tokens: base.tokens,
    tool_calls: base.tool_calls,
    turns: 0,
    final_text: "",
    smoke_pass: null,
    cost_usd: null,
    exit_code: null,
  };

  // Resolve seeds dir per variant.
  let seedsDir: string | null = null;
  if (variant === "code-mode-generic") seedsDir = genericSeedsDir;
  if (variant === "code-mode-tailored") {
    if (!task.seedsDir) {
      result.status = "skipped";
      result.error = "no tailored seeds for this task";
      return result;
    }
    seedsDir = task.seedsDir;
  }

  // Tempdir for /workspace, seeded from fixtures.
  const workdir = mkdtempSync(join(tmpdir(), `bench-${task.id}-${variant}-${rep}-`));
  try {
    if (task.fixturesDir) {
      cpSync(task.fixturesDir, workdir, { recursive: true });
    }

    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN not set");

    const args = [
      "run",
      "--rm",
      "-i",
      "--memory",
      "2g",
      "--cpus",
      "2",
      "-e",
      `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
      "-e",
      `BENCH_VARIANT=${variant}`,
      "-e",
      `BENCH_PROMPT=${task.prompt}`,
      "-e",
      `BENCH_MODEL=${model}`,
    ];

    // Forward any BENCH_FORWARD_* env vars into the container.
    for (const [k, v] of Object.entries(forwardedEnv())) {
      args.push("-e", `${k}=${v}`);
    }

    args.push("-v", `${workdir}:/workspace`);
    if (seedsDir) args.push("-v", `${seedsDir}:/seeds:ro`);
    args.push(image);

    const started = Date.now();
    const timeoutMs = task.timeout_seconds * 1000;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      result.status = "timeout";
      ac.abort();
    }, timeoutMs);

    const proc = Bun.spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      signal: ac.signal,
    });

    // Accumulate stdout line-by-line as stream-json events.
    const acc = newAccumulator();
    let buf = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) ingestLine(acc, line);
      }
    } catch (err) {
      // aborted or read error — handled below via status.
      if (result.status !== "timeout") {
        result.status = "error";
        result.error = err instanceof Error ? err.message : String(err);
      }
    }
    if (buf.length > 0) ingestLine(acc, buf);

    let stderr = "";
    try {
      const s = await new Response(proc.stderr).text();
      stderr = s;
    } catch {
      /* ignore */
    }

    const exit = await proc.exited;
    clearTimeout(timer);

    result.wall_ms = Date.now() - started;
    result.tokens = acc.tokens;
    result.tool_calls = acc.tool_calls;
    result.turns = acc.turns;
    result.final_text = acc.final_text;
    result.cost_usd = acc.cost_usd;
    result.exit_code = exit;

    if (result.status === "ok" && exit !== 0) {
      result.status = "error";
      result.error = stderr.slice(0, 2000);
    }
    // claude exits 0 even on auth / runtime errors; catch those via stream flag.
    if (result.status === "ok" && acc.claude_reported_error) {
      result.status = "error";
      result.error = acc.final_text.slice(0, 2000) || "claude reported is_error=true";
    }

    result.smoke_pass = checkSmoke(task.smoke_check, acc.final_text);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }

  return result;
}
