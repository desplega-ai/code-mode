/**
 * `code-mode query-types <pattern>` — FTS5 search over indexed symbols.
 */

import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate.ts";
import { queryTypes } from "../queries/queryTypes.ts";

export interface QueryTypesOptions {
  path?: string;
  sdk?: string;
  kind?: string;
  limit?: string;
  json?: boolean;
}

export function handler(pattern: string, opts: QueryTypesOptions): void {
  const workspaceDir = resolve(opts.path ?? process.cwd());
  const dbPath = join(workspaceDir, ".code-mode", "code-mode.db");
  const db = new Database(dbPath);
  migrate(db);
  const limit = opts.limit ? Number(opts.limit) : undefined;
  const results = queryTypes(db, {
    pattern: pattern ?? "",
    sdk: opts.sdk,
    kind: opts.kind,
    limit,
  });
  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log(`(no matches for "${pattern}")`);
    return;
  }
  for (const m of results) {
    console.log(
      `${m.kind.padEnd(10)} ${m.name}  [${m.sdkName ?? m.scope}]\n  ${m.signature}`,
    );
  }
}
