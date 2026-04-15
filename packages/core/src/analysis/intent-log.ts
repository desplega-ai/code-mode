/**
 * Append-only JSONL log of agent intents across code-mode tool calls.
 *
 * Every tool that accepts `intent` (run, save, search, query_types) writes
 * one line here per invocation. The file lives at
 * `.code-mode/intent-log.jsonl` and acts as a per-workspace activity feed
 * we can grep later to see what the agent was trying to do — even for
 * searches and type-queries that don't produce artifacts on their own.
 *
 * Rotation: the writer keeps the last `maxEntries` lines (default 1000).
 * When the file exceeds the cap, rotation rewrites it to the tail of the
 * window. Rotation is in-process only; a lock file is overkill for the
 * single-writer pattern of an MCP server handling one request at a time.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type IntentTool = "run" | "save" | "search" | "query_types";

export interface IntentLogEntry {
  ts: string;
  tool: IntentTool;
  intent: string;
  /** Small subset of args worth recording. Keep it flat. */
  meta?: Record<string, unknown>;
}

export interface LogIntentInput {
  codeModeDir: string;
  tool: IntentTool;
  intent: string;
  meta?: Record<string, unknown>;
  /** Rotation cap (default 1000). */
  maxEntries?: number;
}

const DEFAULT_MAX = 1000;
/** Skip rotation scan unless the file has grown past this byte cap (~500 B/line × 1500). */
const ROTATION_BYTE_GATE = 750_000;

export function logIntent(input: LogIntentInput): void {
  const entry: IntentLogEntry = {
    ts: new Date().toISOString(),
    tool: input.tool,
    intent: input.intent,
    ...(input.meta ? { meta: input.meta } : {}),
  };

  const path = logPath(input.codeModeDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");

  // Only scan line count when the file is actually large — otherwise each
  // write would read the whole file just to confirm nothing changed.
  const max = input.maxEntries ?? DEFAULT_MAX;
  const size = safeSize(path);
  if (size < ROTATION_BYTE_GATE) return;

  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length > max) {
    const tail = lines.slice(lines.length - max);
    writeFileSync(path, tail.join("\n") + "\n", "utf8");
  }
}

export function readIntentLog(codeModeDir: string): IntentLogEntry[] {
  const path = logPath(codeModeDir);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  const out: IntentLogEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as IntentLogEntry);
    } catch {
      // Skip corrupt lines rather than blowing up.
    }
  }
  return out;
}

/**
 * Force-rotate the log down to `maxEntries` regardless of file size.
 * Exposed for tests and for explicit compaction by long-running workspaces.
 */
export function compactIntentLog(codeModeDir: string, maxEntries = DEFAULT_MAX): void {
  const path = logPath(codeModeDir);
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (lines.length <= maxEntries) return;
  const tail = lines.slice(lines.length - maxEntries);
  writeFileSync(path, tail.join("\n") + "\n", "utf8");
}

function logPath(codeModeDir: string): string {
  return join(codeModeDir, "intent-log.jsonl");
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
