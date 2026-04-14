import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardedEnv } from "./env.ts";
import { ingestLine, newAccumulator } from "./stream.ts";
import { checkSmoke } from "./tasks.ts";
import type {
  RunResult,
  SessionResult,
  SessionRunResult,
  SessionTaskDef,
  SmokeCheck,
  TaskDef,
  Variant,
} from "./types.ts";

export interface RunOpts {
  task: TaskDef;
  variant: Variant;
  model: string;
  rep: number;
  runId: string;
  image: string;
  /** Absolute path to seeds/generic for variant 2. */
  genericSeedsDir: string;
  /** Absolute host path to the `plugins/code-mode/` dir. Mounted r/o for
   *  the plugin/subagent variants so Claude Code discovers hooks + agents. */
  pluginDir: string;
}

export async function runOne(opts: RunOpts): Promise<RunResult> {
  const { task, variant, model, rep, runId, image, genericSeedsDir, pluginDir } = opts;
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
  // For the plugin/subagent variants we follow the same resolution as
  // `code-mode-tailored` (task-specific seeds preferred, generic fallback).
  // The differentiator for these variants is the PLUGIN mount, not the seeds.
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
  if (variant === "code-mode-plugin" || variant === "code-mode-subagent") {
    seedsDir = task.seedsDir ?? genericSeedsDir;
  }
  // multi-mcp-* variants deliberately receive NO seeds — we want to observe
  // whether the model reaches for the MCP-provided SDKs/tools natively.
  if (
    variant === "multi-mcp-baseline" ||
    variant === "multi-mcp-codemode" ||
    variant === "multi-mcp-block"
  ) {
    seedsDir = null;
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
    if (
      variant === "code-mode-plugin" ||
      variant === "code-mode-subagent" ||
      variant === "multi-mcp-block"
    ) {
      // Mount the host plugin read-only. Entrypoint passes this path via
      // `--plugin-dir` so Claude Code loads hooks/agents/MCP from the
      // plugin's own manifest. multi-mcp-block needs the plugin so its
      // PreToolUse hook can enforce CODE_MODE_MCP_BLOCK.
      args.push("-v", `${pluginDir}:/plugin/code-mode:ro`);
    }
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

// -------------------------------------------------------------------------
// Bench B — cross-session persistence.
// runSessions executes N sessions back-to-back. For code-mode-* variants,
// the `.code-mode/` workspace in `workdir` persists across sessions; for
// baseline each session gets a fresh workdir (no persistence possible).
// -------------------------------------------------------------------------

export interface RunSessionsOpts {
  sessionTask: SessionTaskDef;
  variant: Variant;
  model: string;
  rep: number;
  runId: string;
  image: string;
  genericSeedsDir: string;
  pluginDir: string;
  /** If true, don't rm the persistent workdir after the run (debug). */
  keepWorkdir?: boolean;
}

/**
 * Low-level: spawn one `claude -p` invocation against an existing workdir
 * and mounted seeds. Caller owns workdir lifecycle.
 */
async function execOneSession(args: {
  prompt: string;
  timeoutSec: number;
  smoke: SmokeCheck | undefined;
  workdir: string;
  seedsDir: string | null;
  variant: Variant;
  model: string;
  image: string;
  pluginDir: string;
  taskId: string;
  rep: number;
  runId: string;
}): Promise<RunResult> {
  const base = newAccumulator();
  const result: RunResult = {
    task_id: args.taskId,
    variant: args.variant,
    model: args.model,
    rep: args.rep,
    run_id: args.runId,
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

  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN not set");

  const dockerArgs = [
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
    `BENCH_VARIANT=${args.variant}`,
    "-e",
    `BENCH_PROMPT=${args.prompt}`,
    "-e",
    `BENCH_MODEL=${args.model}`,
  ];
  for (const [k, v] of Object.entries(forwardedEnv())) {
    dockerArgs.push("-e", `${k}=${v}`);
  }
  dockerArgs.push("-v", `${args.workdir}:/workspace`);
  if (args.seedsDir) dockerArgs.push("-v", `${args.seedsDir}:/seeds:ro`);
  if (args.variant === "code-mode-plugin" || args.variant === "code-mode-subagent") {
    dockerArgs.push("-v", `${args.pluginDir}:/plugin/code-mode:ro`);
  }
  dockerArgs.push(args.image);

  const started = Date.now();
  const timeoutMs = args.timeoutSec * 1000;
  const ac = new AbortController();
  const timer = setTimeout(() => {
    result.status = "timeout";
    ac.abort();
  }, timeoutMs);

  const proc = Bun.spawn(["docker", ...dockerArgs], {
    stdout: "pipe",
    stderr: "pipe",
    signal: ac.signal,
  });

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
    if (result.status !== "timeout") {
      result.status = "error";
      result.error = err instanceof Error ? err.message : String(err);
    }
  }
  if (buf.length > 0) ingestLine(acc, buf);

  let stderr = "";
  try {
    stderr = await new Response(proc.stderr).text();
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
  if (result.status === "ok" && acc.claude_reported_error) {
    result.status = "error";
    result.error = acc.final_text.slice(0, 2000) || "claude reported is_error=true";
  }

  result.smoke_pass = checkSmoke(args.smoke, acc.final_text);
  return result;
}

export async function runSessions(opts: RunSessionsOpts): Promise<SessionRunResult> {
  const { sessionTask, variant, model, rep, runId, image, genericSeedsDir, pluginDir } = opts;
  const persist =
    variant === "code-mode-generic" ||
    variant === "code-mode-tailored" ||
    variant === "code-mode-plugin" ||
    variant === "code-mode-subagent";

  // Resolve seeds dir per variant (matches runOne's logic).
  let seedsDir: string | null = null;
  if (variant === "code-mode-generic") seedsDir = genericSeedsDir;
  if (variant === "code-mode-tailored") {
    // Session-tasks in this harness deliberately skip tailored seeds — s1 must
    // build from scratch to simulate real compounding. If a caller DOES provide
    // seeds, use them; otherwise pass null (entrypoint handles empty seeds).
    seedsDir = sessionTask.seedsDir;
  }
  if (variant === "code-mode-plugin" || variant === "code-mode-subagent") {
    seedsDir = sessionTask.seedsDir ?? genericSeedsDir;
  }

  const createdWorkdirs: string[] = [];
  const results: SessionResult[] = [];
  try {
    // Persistent workdir created once; reused across all sessions for code-mode-*.
    let persistentWorkdir: string | null = null;
    if (persist) {
      persistentWorkdir = mkdtempSync(
        join(tmpdir(), `bench-sess-${sessionTask.id}-${variant}-${rep}-`),
      );
      createdWorkdirs.push(persistentWorkdir);
      if (sessionTask.fixturesDir) {
        cpSync(sessionTask.fixturesDir, persistentWorkdir, { recursive: true });
      }
    }

    for (let i = 0; i < sessionTask.sessions.length; i++) {
      const sess = sessionTask.sessions[i]!;

      let workdir: string;
      if (persist) {
        workdir = persistentWorkdir!;
      } else {
        workdir = mkdtempSync(
          join(tmpdir(), `bench-sess-${sessionTask.id}-${variant}-${rep}-s${i + 1}-`),
        );
        createdWorkdirs.push(workdir);
        if (sessionTask.fixturesDir) {
          cpSync(sessionTask.fixturesDir, workdir, { recursive: true });
        }
      }

      const r = await execOneSession({
        prompt: sess.prompt,
        timeoutSec: sess.timeout_seconds,
        smoke: sess.smoke_check,
        workdir,
        seedsDir,
        variant,
        model,
        image,
        pluginDir,
        taskId: sessionTask.id,
        rep,
        runId,
      });

      const sr: SessionResult = {
        ...r,
        session_id: sess.id,
        session_index: i + 1,
        session_task_id: sessionTask.id,
      };
      results.push(sr);
    }
  } finally {
    if (!opts.keepWorkdir) {
      for (const d of createdWorkdirs) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  }

  return {
    session_task_id: sessionTask.id,
    variant,
    model,
    rep,
    run_id: runId,
    sessions: results,
  };
}
void mkdirSync; // reserved for future use; silence unused-import lint
