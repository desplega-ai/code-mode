import type { Tokens, ToolCalls } from "./types.ts";

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
}

export interface StreamAccumulator {
  tokens: Tokens;
  tool_calls: ToolCalls;
  turns: number;
  final_text: string;
  /** True if the final `result` event declared is_error. */
  claude_reported_error: boolean;
}

export function newAccumulator(): StreamAccumulator {
  return {
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
    tool_calls: { total: 0, by_name: {} },
    turns: 0,
    final_text: "",
    claude_reported_error: false,
  };
}

/**
 * Feed a single stream-json line into the accumulator.
 * Claude Code's stream-json emits one JSON object per line. Unknown or malformed
 * lines are ignored (stream can include non-JSON stderr bleed in edge cases).
 */
export function ingestLine(acc: StreamAccumulator, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let evt: unknown;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!evt || typeof evt !== "object") return;
  const e = evt as Record<string, unknown>;

  // "assistant" events contain the outbound message with usage + content blocks.
  if (e.type === "assistant" && e.message && typeof e.message === "object") {
    acc.turns += 1;
    const msg = e.message as Record<string, unknown>;
    accumulateUsage(acc, msg.usage as Usage | undefined);
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content as ContentBlock[]) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use" && typeof block.name === "string") {
          acc.tool_calls.total += 1;
          acc.tool_calls.by_name[block.name] =
            (acc.tool_calls.by_name[block.name] ?? 0) + 1;
        }
        if (block.type === "text" && typeof block.text === "string") {
          // Keep latest assistant text — the final message wins.
          acc.final_text = block.text;
        }
      }
    }
    return;
  }

  // "result" event (emitted at the end by stream-json) also carries final usage.
  if (e.type === "result") {
    if (e.usage) accumulateUsage(acc, e.usage as Usage);
    if (typeof e.result === "string" && e.result.length > 0) {
      acc.final_text = e.result;
    }
    if (e.is_error === true) acc.claude_reported_error = true;
  }
}

function accumulateUsage(acc: StreamAccumulator, u: Usage | undefined): void {
  if (!u || typeof u !== "object") return;
  acc.tokens.input += u.input_tokens ?? 0;
  acc.tokens.output += u.output_tokens ?? 0;
  acc.tokens.cache_read += u.cache_read_input_tokens ?? 0;
  acc.tokens.cache_creation += u.cache_creation_input_tokens ?? 0;
}
