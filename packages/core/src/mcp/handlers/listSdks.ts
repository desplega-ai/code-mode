/**
 * MCP tool handler: `list_sdks`.
 */

import type { Database } from "bun:sqlite";
import { listSdks, type SdkSummary } from "../../queries/listSdks.ts";

export interface ListSdksResult {
  sdks: SdkSummary[];
}

export function handleListSdks(db: Database): ListSdksResult {
  return { sdks: listSdks(db) };
}
