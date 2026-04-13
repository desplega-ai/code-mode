/**
 * `code-mode reindex` — rebuild the SQLite+FTS5 index for a workspace.
 *
 * Flags:
 *   --path <dir>            target workspace (defaults to cwd)
 *   --paths <a,b,c>         comma-separated absolute paths; only re-process these
 *   --mcp-config <path>     explicit MCP config file for SDK generation
 *   --no-sdk-gen            skip the MCP SDK generation step
 */

import { reindex, resolveWorkspacePaths } from "../index/reindex.ts";
import { generateSdks } from "../sdk-gen/index.ts";

export interface ReindexOptions {
  path?: string;
  paths?: string;
  mcpConfig?: string;
  sdkGen?: boolean;
  /** Commander `--no-templates` → `templates: false`. Defaults to true. */
  templates?: boolean;
}

export async function handler(opts: ReindexOptions): Promise<void> {
  const workspaceDir = opts.path ?? process.cwd();
  const pathList = opts.paths
    ? opts.paths.split(",").map((p) => p.trim()).filter(Boolean)
    : undefined;

  const ws = resolveWorkspacePaths(workspaceDir);

  // sdk-gen runs first (unless --no-sdk-gen) so the generated files exist on
  // disk by the time the filesystem walker in reindex() picks them up.
  const runSdkGen = opts.sdkGen !== false;
  if (runSdkGen) {
    try {
      const sdkReport = await generateSdks({
        workspaceDir: ws.workspaceDir,
        sdksDir: ws.sdksDir,
        scriptsDir: ws.scriptsDir,
        templates: opts.templates,
        mcpConfigPath: opts.mcpConfig,
      });
      const ok = sdkReport.emit.serverFiles.length;
      const skipped = sdkReport.emit.skipped.length;
      console.log(
        `[code-mode sdk-gen] servers=${ok}+/${skipped} skipped ` +
          `sources=${sdkReport.sources.length} ` +
          `configErrors=${sdkReport.discoveryErrors.length}`,
      );
      for (const s of sdkReport.emit.skipped) {
        console.log(`  [sdk-gen] skipped ${s.server}: ${s.reason}`);
      }
    } catch (err) {
      // sdk-gen failures must never abort the reindex itself — surface via doctor.
      console.log(
        `[code-mode sdk-gen] failed: ${(err as Error).message} — continuing reindex`,
      );
    }
  }

  const report = await reindex(workspaceDir, { paths: pathList });
  console.log(
    `[code-mode reindex] scripts=${report.scriptsIndexed}+/${report.scriptsRemoved}- ` +
      `symbols=${report.symbolsIndexed}+/${report.symbolsRemoved}- ` +
      `sdks=${report.sdks.length} ` +
      `time=${report.durationMs}ms`,
  );
}
