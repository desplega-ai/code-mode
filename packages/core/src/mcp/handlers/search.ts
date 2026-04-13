/**
 * MCP tool handler: `search`.
 */

import type { Database } from "better-sqlite3";
import { search, type SearchHit, type SearchScope } from "../../queries/search.ts";

export interface SearchArgs {
  query: string;
  scope?: SearchScope;
  kind?: string;
  limit?: number;
}

export interface SearchResult {
  results: SearchHit[];
}

export function handleSearch(db: Database, args: SearchArgs): SearchResult {
  const results = search(db, {
    query: args.query ?? "",
    scope: args.scope,
    kind: args.kind,
    limit: args.limit,
  });
  return { results };
}
