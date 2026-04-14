import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  RunResult,
  SessionResult,
  SessionRunResult,
  Variant,
} from "./types.ts";
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
      `| Model | Variant | Status | Wall (ms) | Tokens (total) | Cost (USD) | Tool calls | Δ wall | Δ tokens | Δ cost | Δ calls |`,
    );
    lines.push(`|---|---|---|---|---|---|---|---|---|---|---|`);

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
      const baselineCost = agg(
        baselineOk.flatMap((r) => (typeof r.cost_usd === "number" ? [r.cost_usd] : [])),
      );

      for (const variant of ALL_VARIANTS) {
        const cell = variants.get(variant);
        if (!cell || cell.runs.length === 0) {
          lines.push(`| \`${model}\` | \`${variant}\` | — | — | — | — | — | — | — | — | — |`);
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
        const cost = agg(ok.flatMap((r) => (typeof r.cost_usd === "number" ? [r.cost_usd] : [])));
        const hasData = ok.length > 0;
        const dWall =
          variant === "baseline" || !hasData ? "—" : deltaPct(wall.median, baselineWall.median);
        const dTok =
          variant === "baseline" || !hasData ? "—" : deltaPct(tok.median, baselineTok.median);
        const dCalls =
          variant === "baseline" || !hasData ? "—" : deltaPct(calls.median, baselineCalls.median);
        const dCost =
          variant === "baseline" || !hasData || baselineCost.median === 0
            ? "—"
            : deltaPct(cost.median, baselineCost.median);
        const costCell = cost.median > 0 ? `$${cost.median.toFixed(4)}` : "—";
        lines.push(
          `| \`${model}\` | \`${variant}\` | ${statusLabel} | ${fmt(wall)} | ${fmt(tok)} | ${costCell} | ${fmt(calls)} | ${dWall} | ${dTok} | ${dCost} | ${dCalls} |`,
        );
        modelOut[variant] = {
          n: cell.runs.length,
          ok: ok.length,
          skipped,
          failed,
          wall_ms: wall,
          tokens_total: tok,
          cost_usd: cost,
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

// -------------------------------------------------------------------------
// Bench B — cross-session persistence report.
// Per (session-task, variant, model): s1 + s2 wall/cost/calls, and the
// headline "Δ s2 vs baseline s2" — i.e. how much the persisted `.code-mode/`
// helps the second session when the baseline had no persistence to lean on.
// -------------------------------------------------------------------------

function pickToolCalls(r: SessionResult): string {
  const notable = ["mcp__code-mode__run", "mcp__code-mode__search", "mcp__code-mode__save", "Task", "Bash"];
  const hits = notable
    .map((n) => [n, r.tool_calls.by_name[n] ?? 0] as const)
    .filter(([, c]) => c > 0)
    .map(([n, c]) => `${n}=${c}`);
  return hits.length > 0 ? hits.join(", ") : "—";
}

function sessionDeltaPct(current: number, baseline: number): string {
  if (baseline === 0) return "n/a";
  const pct = ((current - baseline) / baseline) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

function tokensTotal(r: SessionResult): number {
  return r.tokens.input + r.tokens.output + r.tokens.cache_read + r.tokens.cache_creation;
}

export function writeSessionReport(outDir: string, runs: SessionRunResult[]): void {
  // Group: session_task_id -> model -> variant -> rep -> SessionRunResult
  // For v1 we'll simply emit per-pair rows; aggregation across reps is left
  // for a future pass once we have N>1.
  const byTask = new Map<string, SessionRunResult[]>();
  for (const r of runs) {
    const list = byTask.get(r.session_task_id) ?? [];
    list.push(r);
    byTask.set(r.session_task_id, list);
  }

  const lines: string[] = [];
  lines.push(`# code-mode bench B — cross-session persistence report`);
  lines.push("");
  lines.push(`Runs: ${runs.length} pair(s) across ${byTask.size} session-task(s)`);
  lines.push("");
  lines.push(
    `Hypothesis: for code-mode-* variants, session 2 reuses scripts/knowledge from session 1's persistent \`.code-mode/\` workspace, so s2 is faster/cheaper than baseline's s2 (which starts fresh).`,
  );
  lines.push("");

  for (const [taskId, pairs] of [...byTask.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${taskId}`);
    lines.push("");

    // Build a baseline lookup per (model, rep) -> s2 wall/cost for deltas.
    const baselineS2 = new Map<string, { wall: number; cost: number | null; tokens: number }>();
    for (const p of pairs) {
      if (p.variant !== "baseline") continue;
      const s2 = p.sessions[1];
      if (!s2 || s2.status !== "ok") continue;
      baselineS2.set(`${p.model}|${p.rep}`, {
        wall: s2.wall_ms,
        cost: s2.cost_usd,
        tokens: tokensTotal(s2),
      });
    }

    lines.push(
      `| Model | Variant | Rep | Session | Status | Wall (ms) | Tokens | Cost (USD) | Calls | Tool breakdown | Δ wall vs base s2 | Δ cost vs base s2 |`,
    );
    lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);

    const sorted = [...pairs].sort(
      (a, b) =>
        a.model.localeCompare(b.model) ||
        a.variant.localeCompare(b.variant) ||
        a.rep - b.rep,
    );
    for (const p of sorted) {
      const baseKey = `${p.model}|${p.rep}`;
      const base = baselineS2.get(baseKey);
      for (const s of p.sessions) {
        const walltxt = `${s.wall_ms}`;
        const toktxt = `${tokensTotal(s)}`;
        const costtxt = typeof s.cost_usd === "number" ? `$${s.cost_usd.toFixed(4)}` : "—";
        const callsTxt = `${s.tool_calls.total}`;
        const breakdown = pickToolCalls(s);
        const showDelta = s.session_index === 2 && p.variant !== "baseline" && base;
        const dWall = showDelta ? sessionDeltaPct(s.wall_ms, base!.wall) : "—";
        const dCost =
          showDelta && typeof s.cost_usd === "number" && typeof base!.cost === "number" && base!.cost > 0
            ? sessionDeltaPct(s.cost_usd, base!.cost)
            : "—";
        lines.push(
          `| \`${p.model}\` | \`${p.variant}\` | ${p.rep} | ${s.session_id} | ${s.status} | ${walltxt} | ${toktxt} | ${costtxt} | ${callsTxt} | ${breakdown} | ${dWall} | ${dCost} |`,
        );
      }
    }

    lines.push("");
    lines.push(
      `**Headline:** if \`code-mode-tailored\` s2 shows meaningful negative Δ vs baseline s2 wall/cost AND a non-zero \`mcp__code-mode__run\` or \`mcp__code-mode__search\` count (or a \`Task\` subagent delegation), persistence is working.`,
    );
    lines.push("");
  }

  writeFileSync(join(outDir, "session-report.md"), lines.join("\n"));
  writeFileSync(
    join(outDir, "session-report.json"),
    JSON.stringify({ runs }, null, 2),
  );
}
