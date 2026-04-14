export type Variant = "baseline" | "code-mode-generic" | "code-mode-tailored";

export const ALL_VARIANTS: Variant[] = [
  "baseline",
  "code-mode-generic",
  "code-mode-tailored",
];

export type SmokeCheck =
  | { kind: "includes_all"; needles: string[] }
  | { kind: "regex"; pattern: string; flags?: string };

export interface TaskDef {
  id: string;
  prompt: string;
  timeout_seconds: number;
  smoke_check?: SmokeCheck;
  /** Absolute path to the task dir on the host. */
  dir: string;
  /** Absolute path to fixtures/ if present, else null. */
  fixturesDir: string | null;
  /** Absolute path to seeds/ if present, else null. */
  seedsDir: string | null;
}

export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface ToolCalls {
  total: number;
  by_name: Record<string, number>;
}

export type RunStatus = "ok" | "timeout" | "error" | "skipped";

export interface RunResult {
  task_id: string;
  variant: Variant;
  model: string;
  rep: number;
  run_id: string;
  status: RunStatus;
  wall_ms: number;
  tokens: Tokens;
  tool_calls: ToolCalls;
  turns: number;
  final_text: string;
  smoke_pass: boolean | null;
  /** Claude's own reported cost (USD). null if not emitted (e.g. timeout). */
  cost_usd: number | null;
  exit_code: number | null;
  error?: string;
}
