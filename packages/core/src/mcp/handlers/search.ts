/**
 * MCP tool handler: `search`.
 *
 * Intent is optional here — search is often used as a reflex before deciding
 * what to do next, so requiring a 4-word justification would be friction.
 * When provided, it gets appended to the intent log so the activity feed
 * shows what the agent was looking for, not just which hits came back.
 */

import type { Database } from "better-sqlite3";
import { search, type SearchHit, type SearchScope } from "../../queries/search.ts";
import { logIntent } from "../../analysis/intent-log.ts";

export interface SearchArgs {
  query: string;
  scope?: SearchScope;
  kind?: string;
  limit?: number;
  /**
   * Optional: short description of what the agent is searching for.
   * Logged to intent-log.jsonl when present. Not validated.
   */
  intent?: string;
}

export interface SearchResult {
  results: SearchHit[];
}

export function handleSearch(
  db: Database,
  args: SearchArgs,
  codeModeDir?: string,
): SearchResult {
  if (args.intent && args.intent.trim() && codeModeDir) {
    try {
      logIntent({
        codeModeDir,
        tool: "search",
        intent: args.intent.trim(),
        meta: {
          query: args.query,
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.kind ? { kind: args.kind } : {}),
        },
      });
    } catch {
      // Never fail a search because of telemetry.
    }
  }
  const results = search(db, {
    query: args.query ?? "",
    scope: args.scope,
    kind: args.kind,
    limit: args.limit,
  });
  return { results };
}
