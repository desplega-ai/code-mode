import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult, Variant } from "./types.ts";
import { ALL_VARIANTS } from "./types.ts";

interface Cell {
  runs: RunResult[];
}

interface Agg {
  median: number;
  min: number;
  max: number;
}

function agg(values: number[]): Agg {
  if (values.length === 0) return { median: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return { median, min: sorted[0]!, max: sorted[sorted.length - 1]! };
}

function totalTokens(r: RunResult): number {
  return r.tokens.input + r.tokens.output + r.tokens.cache_read + r.tokens.cache_creation;
}

function fmt(a: Agg, unit: string = ""): string {
  if (a.median === a.min && a.min === a.max) return `${round(a.median)}${unit}`;
  return `${round(a.median)}${unit} (${round(a.min)}–${round(a.max)})`;
}

function round(n: number): string {
  if (n >= 10000) return Math.round(n).toLocaleString();
  if (n >= 100) return Math.round(n).toString();
  return n.toFixed(1);
}

function deltaPct(current: number, baseline: number): string {
  if (baseline === 0) return "n/a";
  const pct = ((current - baseline) / baseline) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

export function writeReport(outDir: string, runs: RunResult[]): void {
  // Group: task_id -> model -> variant -> cell
  const byTask = new Map<string, Map<string, Map<Variant, Cell>>>();
  const modelSet = new Set<string>();
  for (const r of runs) {
    modelSet.add(r.model);
    const byModel = byTask.get(r.task_id) ?? new Map<string, Map<Variant, Cell>>();
    byTask.set(r.task_id, byModel);
    const byVariant = byModel.get(r.model) ?? new Map<Variant, Cell>();
    byModel.set(r.model, byVariant);
    const c = byVariant.get(r.variant) ?? { runs: [] };
    byVariant.set(r.variant, c);
    c.runs.push(r);
  }

  const taskIds = [...byTask.keys()].sort();
  const models = [...modelSet].sort();
  const reportJson: Record<string, unknown> = {
    run_id: runs[0]?.run_id ?? "",
    models,
    tasks: {},
  };
  const tasksJson = reportJson.tasks as Record<string, unknown>;

  const lines: string[] = [];
  lines.push(`# code-mode benchmark report`);
  lines.push("");
  lines.push(`Run: \`${runs[0]?.run_id ?? "unknown"}\``);
  lines.push(
    `Runs: ${runs.length} (${taskIds.length} tasks × up to ${ALL_VARIANTS.length} variants × ${models.length} model(s))`,
  );
  lines.push(`Models: ${models.map((m) => `\`${m}\``).join(", ")}`);
  lines.push("");

  for (const taskId of taskIds) {
    const byModel = byTask.get(taskId)!;
    lines.push(`## ${taskId}`);
    lines.push("");
    lines.push(
      `| Model | Variant | Status | Wall (ms) | Tokens (total) | Tool calls | Δ wall | Δ tokens | Δ calls |`,
    );
    lines.push(`|---|---|---|---|---|---|---|---|---|`);

    const taskOut: Record<string, unknown> = {};
    for (const model of models) {
      const variants = byModel.get(model);
      const modelOut: Record<string, unknown> = {};
      if (!variants) {
        lines.push(`| \`${model}\` | — | — | — | — | — | — | — | — |`);
        taskOut[model] = modelOut;
        continue;
      }

      const baselineCell = variants.get("baseline");
      const baselineOk = baselineCell?.runs.filter((r) => r.status === "ok") ?? [];
      const baselineWall = agg(baselineOk.map((r) => r.wall_ms));
      const baselineTok = agg(baselineOk.map(totalTokens));
      const baselineCalls = agg(baselineOk.map((r) => r.tool_calls.total));

      for (const variant of ALL_VARIANTS) {
        const cell = variants.get(variant);
        if (!cell || cell.runs.length === 0) {
          lines.push(`| \`${model}\` | \`${variant}\` | — | — | — | — | — | — | — |`);
          continue;
        }
        const ok = cell.runs.filter((r) => r.status === "ok");
        const skipped = cell.runs.filter((r) => r.status === "skipped").length;
        const failed = cell.runs.length - ok.length - skipped;
        const statusLabel =
          ok.length === cell.runs.length
            ? "ok"
            : skipped === cell.runs.length
              ? "skipped"
              : `${ok.length}/${cell.runs.length} ok, ${failed} fail, ${skipped} skip`;
        const wall = agg(ok.map((r) => r.wall_ms));
        const tok = agg(ok.map(totalTokens));
        const calls = agg(ok.map((r) => r.tool_calls.total));
        const hasData = ok.length > 0;
        const dWall =
          variant === "baseline" || !hasData ? "—" : deltaPct(wall.median, baselineWall.median);
        const dTok =
          variant === "baseline" || !hasData ? "—" : deltaPct(tok.median, baselineTok.median);
        const dCalls =
          variant === "baseline" || !hasData ? "—" : deltaPct(calls.median, baselineCalls.median);
        lines.push(
          `| \`${model}\` | \`${variant}\` | ${statusLabel} | ${fmt(wall)} | ${fmt(tok)} | ${fmt(calls)} | ${dWall} | ${dTok} | ${dCalls} |`,
        );
        modelOut[variant] = {
          n: cell.runs.length,
          ok: ok.length,
          skipped,
          failed,
          wall_ms: wall,
          tokens_total: tok,
          tool_calls_total: calls,
        };
      }
      taskOut[model] = modelOut;
    }
    tasksJson[taskId] = taskOut;
    lines.push("");
  }

  writeFileSync(join(outDir, "report.md"), lines.join("\n"));
  writeFileSync(join(outDir, "report.json"), JSON.stringify(reportJson, null, 2));
}
