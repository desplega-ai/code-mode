/**
 * `code-mode reindex` — rebuild the SQLite+FTS5 index for a workspace.
 *
 * Flags:
 *   --path <dir>       target workspace (defaults to cwd)
 *   --paths <a,b,c>    comma-separated absolute paths; only re-process these
 */

import { reindex } from "../index/reindex.ts";

export interface ReindexOptions {
  path?: string;
  paths?: string;
}

export async function handler(opts: ReindexOptions): Promise<void> {
  const workspaceDir = opts.path ?? process.cwd();
  const pathList = opts.paths
    ? opts.paths.split(",").map((p) => p.trim()).filter(Boolean)
    : undefined;

  const report = await reindex(workspaceDir, { paths: pathList });
  console.log(
    `[code-mode reindex] scripts=${report.scriptsIndexed}+/${report.scriptsRemoved}- ` +
      `symbols=${report.symbolsIndexed}+/${report.symbolsRemoved}- ` +
      `sdks=${report.sdks.length} ` +
      `time=${report.durationMs}ms`,
  );
}
