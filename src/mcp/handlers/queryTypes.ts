/**
 * MCP tool handler: `query_types`.
 */

import type { Database } from "bun:sqlite";
import { queryTypes, type SymbolMatch } from "../../queries/queryTypes.ts";

export interface QueryTypesArgs {
  pattern: string;
  sdk?: string;
  kind?: string;
  limit?: number;
}

export interface QueryTypesResult {
  matches: SymbolMatch[];
}

export function handleQueryTypes(
  db: Database,
  args: QueryTypesArgs,
): QueryTypesResult {
  const matches = queryTypes(db, {
    pattern: args.pattern ?? "",
    sdk: args.sdk,
    kind: args.kind,
    limit: args.limit,
  });
  return { matches };
}
