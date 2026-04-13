/**
 * `code-mode list-sdks` — print every indexed SDK.
 */

import { join, resolve } from "node:path";
import { openDatabase } from "../db/open.ts";
import { migrate } from "../db/migrate.ts";
import { listSdks } from "../queries/listSdks.ts";

export interface ListSdksOptions {
  path?: string;
  json?: boolean;
}

export function handler(opts: ListSdksOptions): void {
  const workspaceDir = resolve(opts.path ?? process.cwd());
  const dbPath = join(workspaceDir, ".code-mode", "code-mode.db");
  const db = openDatabase(dbPath);
  migrate(db);
  const sdks = listSdks(db);
  if (opts.json) {
    console.log(JSON.stringify(sdks, null, 2));
    return;
  }
  if (sdks.length === 0) {
    console.log("(no SDKs indexed — run 'code-mode reindex')");
    return;
  }
  for (const s of sdks) {
    console.log(
      `${s.name.padEnd(24)} ${s.scope.padEnd(10)} ${String(s.symbolCount).padStart(4)} symbols  ${s.lastIndexed}`,
    );
  }
}
