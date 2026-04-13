/**
 * `list_sdks` — summary of every indexed SDK.
 *
 * Returned directly by the CLI (`code-mode list-sdks`) and by the MCP tool of
 * the same name (wired in Phase 7).
 */

import type { Database } from "better-sqlite3";
import { listSdkRows } from "../db/repo.ts";
import type { SdkScope } from "../db/schema.ts";

export interface SdkSummary {
  name: string;
  scope: SdkScope;
  sourceDir: string;
  symbolCount: number;
  lastIndexed: string;
}

export function listSdks(db: Database): SdkSummary[] {
  return listSdkRows(db).map((r) => ({
    name: r.name,
    scope: r.scope,
    sourceDir: r.source_dir,
    symbolCount: r.symbol_count,
    lastIndexed: r.last_indexed,
  }));
}
