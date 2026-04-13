/**
 * MCP tool handler: `list_sdks`.
 */

import type { Database } from "better-sqlite3";
import { listSdks, type SdkSummary } from "../../queries/listSdks.ts";

export interface ListSdksResult {
  sdks: SdkSummary[];
  /**
   * Present only when `sdks` is empty. Hints to MCP callers (agents) that
   * the workspace hasn't been indexed yet — the CLI variant prints its own
   * empty-state hint, but MCP callers would otherwise see a silent `[]`.
   */
  note?: string;
}

const EMPTY_NOTE =
  "no SDKs indexed yet. Run `code-mode reindex` in the workspace to generate SDK bindings for registered MCP servers. The 'stdlib' SDK (fetch, grep, glob, table, filter, flatten, fuzzy-match) will also be indexed.";

export function handleListSdks(db: Database): ListSdksResult {
  const sdks = listSdks(db);
  if (sdks.length === 0) {
    return { sdks, note: EMPTY_NOTE };
  }
  return { sdks };
}
