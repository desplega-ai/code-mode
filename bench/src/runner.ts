#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOne } from "./docker.ts";
import { loadDotEnv } from "./env.ts";
import { writeReport } from "./report.ts";
import { loadTasks } from "./tasks.ts";
import { ALL_VARIANTS, type RunResult, type Variant } from "./types.ts";

interface CliArgs {
  tasks: string;
  variants: Variant[];
  models: string[];
  reps: number;
  concurrency: number;
  out: string;
  image: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Map shorthand aliases to full model IDs. Pass-through for unknown values. */
const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

function resolveModel(s: string): string {
  const trimmed = s.trim();
  return MODEL_ALIASES[trimmed] ?? trimmed;
}

function parseModels(s: string): string[] {
  const parts = s
    .split(",")
    .map((p) => resolveModel(p))
    .filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error(`--models: empty list`);
  return parts;
}

function parseArgs(argv: string[]): CliArgs {
  const defaults: CliArgs = {
    tasks: "tasks",
    variants: [...ALL_VARIANTS],
    models: [DEFAULT_MODEL],
    reps: 3,
    concurrency: 2,
    out: `results/${timestamp()}`,
    image: "code-mode-bench:latest",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    const eat = () => {
      if (next === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--tasks": defaults.tasks = eat(); break;
      case "--variants": defaults.variants = parseVariants(eat()); break;
      case "--models": defaults.models = parseModels(eat()); break;
      case "--model": defaults.models = [resolveModel(eat())]; break;
      case "--reps": defaults.reps = parseInt(eat(), 10); break;
      case "--concurrency": defaults.concurrency = parseInt(eat(), 10); break;
      case "--out": defaults.out = eat(); break;
      case "--image": defaults.image = eat(); break;
      case "-h": case "--help":
        printHelp(); process.exit(0);
      default:
        if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    }
  }
  // Env-level defaults (lower precedence than CLI).
  const envReps = process.env.BENCH_DEFAULT_REPS;
  const envCon = process.env.BENCH_DEFAULT_CONCURRENCY;
  const envModels = process.env.BENCH_DEFAULT_MODELS;
  if (envReps && !argv.includes("--reps")) defaults.reps = parseInt(envReps, 10);
  if (envCon && !argv.includes("--concurrency")) defaults.concurrency = parseInt(envCon, 10);
  if (envModels && !argv.includes("--models") && !argv.includes("--model")) {
    defaults.models = parseModels(envModels);
  }
  return defaults;
}

function parseVariants(s: string): Variant[] {
  const parts = s.split(",").map((p) => p.trim()) as Variant[];
  for (const p of parts) {
    if (!ALL_VARIANTS.includes(p)) throw new Error(`unknown variant: ${p}`);
  }
  return parts;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

/** Make a model ID filesystem-safe (no slashes, colons, etc). */
function safeModel(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function printHelp(): void {
  const msg = `bench — code-mode benchmark harness

Usage: bun run bench [flags]

Flags:
  --tasks PATH           Task dir or parent of task dirs (default: tasks)
  --variants CSV         baseline,code-mode-generic,code-mode-tailored
  --models CSV           Model IDs/aliases, e.g. sonnet,opus or
                         claude-sonnet-4-6,claude-opus-4-6
                         (default: ${DEFAULT_MODEL})
  --model ID             Convenience alias for --models with a single value
  --reps N               Repetitions per (task,variant,model) (default: 3)
  --concurrency N        Parallel containers (default: 2)
  --out PATH             Results directory (default: results/<ts>)
  --image NAME           Docker image (default: code-mode-bench:latest)
`;
  process.stdout.write(msg);
}

interface Job {
  taskId: string;
  variant: Variant;
  model: string;
  rep: number;
  run: () => Promise<RunResult>;
}

async function runWithConcurrency(jobs: Job[], concurrency: number): Promise<RunResult[]> {
  const results: RunResult[] = [];
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const total = jobs.length;
  for (let w = 0; w < Math.max(1, concurrency); w++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= total) return;
        const job = jobs[idx]!;
        const label = `[${idx + 1}/${total}] ${job.taskId}/${job.variant}/${job.model} rep=${job.rep}`;
        const t0 = Date.now();
        process.stderr.write(`${label} starting\n`);
        try {
          const r = await job.run();
          const tag = r.status === "ok" ? "ok" : r.status.toUpperCase();
          process.stderr.write(`${label} ${tag} in ${Date.now() - t0}ms\n`);
          results.push(r);
        } catch (err) {
          process.stderr.write(`${label} CRASH: ${err instanceof Error ? err.message : err}\n`);
          results.push({
            task_id: job.taskId,
            variant: job.variant,
            model: job.model,
            rep: job.rep,
            run_id: "",
            status: "error",
            wall_ms: Date.now() - t0,
            tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
            tool_calls: { total: 0, by_name: {} },
            turns: 0,
            final_text: "",
            smoke_pass: null,
            cost_usd: null,
            exit_code: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  // Resolve bench root = parent dir of src/.
  const benchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  loadDotEnv(join(benchRoot, ".env"));

  const args = parseArgs(process.argv.slice(2));
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error("error: CLAUDE_CODE_OAUTH_TOKEN not set (put it in bench/.env or export it)");
    process.exit(1);
  }

  const tasksPath = resolve(benchRoot, args.tasks);
  const tasks = loadTasks(tasksPath);
  const genericSeedsDir = join(benchRoot, "seeds", "generic");
  const outDir = resolve(benchRoot, args.out);
  mkdirSync(join(outDir, "raw"), { recursive: true });

  const runId = timestamp();
  const jobs: Job[] = [];
  for (const task of tasks) {
    for (const variant of args.variants) {
      for (const model of args.models) {
        for (let rep = 1; rep <= args.reps; rep++) {
          jobs.push({
            taskId: task.id,
            variant,
            model,
            rep,
            run: () => runOne({ task, variant, model, rep, runId, image: args.image, genericSeedsDir }),
          });
        }
      }
    }
  }

  console.log(`[bench] ${jobs.length} runs across ${tasks.length} task(s), ${args.variants.length} variant(s), ${args.models.length} model(s), ${args.reps} rep(s)`);
  console.log(`[bench] models=${args.models.join(",")} concurrency=${args.concurrency} image=${args.image} out=${outDir}`);

  const results = await runWithConcurrency(jobs, args.concurrency);

  for (const r of results) {
    const file = join(outDir, "raw", `${r.task_id}.${r.variant}.${safeModel(r.model)}.${r.rep}.json`);
    writeFileSync(file, JSON.stringify(r, null, 2));
  }

  writeReport(outDir, results);
  console.log(`\n[bench] done. report: ${join(outDir, "report.md")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
