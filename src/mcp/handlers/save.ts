/**
 * MCP tool handler: `save`.
 *
 * Writes the script inline (via source string), then invokes the same path the
 * CLI uses. Delegates to `commands/save.ts` with `_returnResult` so we can
 * surface errors cleanly.
 */

import { handler as saveHandler, type SaveResult } from "../../commands/save.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SaveArgs {
  name: string;
  source: string;
  description?: string;
  tags?: string[];
  overwrite?: boolean;
}

export async function handleSave(
  workspaceDir: string,
  args: SaveArgs,
): Promise<SaveResult> {
  if (!args.name) {
    return { success: false, error: "save: `name` is required" };
  }
  if (!args.source) {
    return { success: false, error: "save: `source` is required" };
  }

  // Write source to a temp file so we can reuse the CLI path (which expects
  // --file <path>). Temp file gets cleaned up whether save succeeds or fails.
  const tmp = mkdtempSync(join(tmpdir(), "code-mode-mcp-save-"));
  const tmpFile = join(tmp, `${args.name.replace(/\//g, "_")}.ts`);
  writeFileSync(tmpFile, args.source, "utf8");

  try {
    const result = await saveHandler({
      name: args.name,
      file: tmpFile,
      path: workspaceDir,
      overwrite: args.overwrite,
      _returnResult: true,
    });
    return result as SaveResult;
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
