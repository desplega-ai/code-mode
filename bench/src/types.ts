export type Variant =
  | "baseline"
  | "code-mode-generic"
  | "code-mode-tailored"
  | "code-mode-plugin"
  | "code-mode-subagent"
  | "multi-mcp-baseline"
  | "multi-mcp-codemode"
  | "multi-mcp-block";

export const ALL_VARIANTS: Variant[] = [
  "baseline",
  "code-mode-generic",
  "code-mode-tailored",
  "code-mode-plugin",
  "code-mode-subagent",
  "multi-mcp-baseline",
  "multi-mcp-codemode",
  "multi-mcp-block",
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

// -------------------------------------------------------------------------
// Bench B — cross-session persistence types (additive; do not modify above).
// -------------------------------------------------------------------------

export interface SessionDef {
  id: string;
  prompt: string;
  timeout_seconds: number;
  smoke_check?: SmokeCheck;
}

export interface SessionTaskDef {
  id: string;
  sessions: SessionDef[];
  /** Absolute path to the session-task dir on the host. */
  dir: string;
  /** Absolute path to fixtures/ if present, else null. */
  fixturesDir: string | null;
  /** Absolute path to seeds/ if present, else null. */
  seedsDir: string | null;
}

export interface SessionResult extends RunResult {
  session_id: string;
  /** Numeric index (1-based) of this session within its session-task. */
  session_index: number;
  /** Session-task id (duplicated from RunResult.task_id for clarity). */
  session_task_id: string;
}

export interface SessionRunResult {
  session_task_id: string;
  variant: Variant;
  model: string;
  rep: number;
  run_id: string;
  sessions: SessionResult[];
}
