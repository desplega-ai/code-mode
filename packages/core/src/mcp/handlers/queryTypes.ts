/**
 * MCP tool handler: `query_types`.
 *
 * Intent is optional — same rationale as `search`: type queries are
 * exploratory, forcing a justification is friction. Logged when present.
 */

import type { Database } from "better-sqlite3";
import { queryTypes, type SymbolMatch } from "../../queries/queryTypes.ts";
import { logIntent } from "../../analysis/intent-log.ts";

export interface QueryTypesArgs {
  pattern: string;
  sdk?: string;
  kind?: string;
  limit?: number;
  /**
   * Optional: short description of what the agent is looking up types for.
   * Logged to intent-log.jsonl when present. Not validated.
   */
  intent?: string;
}

export interface QueryTypesResult {
  matches: SymbolMatch[];
}

export function handleQueryTypes(
  db: Database,
  args: QueryTypesArgs,
  codeModeDir?: string,
): QueryTypesResult {
  if (args.intent && args.intent.trim() && codeModeDir) {
    try {
      logIntent({
        codeModeDir,
        tool: "query_types",
        intent: args.intent.trim(),
        meta: {
          pattern: args.pattern,
          ...(args.sdk ? { sdk: args.sdk } : {}),
          ...(args.kind ? { kind: args.kind } : {}),
        },
      });
    } catch {
      // Never fail a type query because of telemetry.
    }
  }
  const matches = queryTypes(db, {
    pattern: args.pattern ?? "",
    sdk: args.sdk,
    kind: args.kind,
    limit: args.limit,
  });
  return { matches };
}
