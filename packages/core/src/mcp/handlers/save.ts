/**
 * MCP tool handler: `save`.
 *
 * Writes the script inline (via source string), then invokes the same path the
 * CLI uses. Delegates to `commands/save.ts` with `_returnResult` so we can
 * surface errors cleanly.
 *
 * Intent: required — mirrors `run`'s rule. Even though `save` already has a
 * `name` and optional `description`, we demand an intent so the telemetry
 * feed in intent-log.jsonl reflects every save call and the agent is
 * explicit about why it's persisting this particular script.
 */

import { handler as saveHandler, type SaveResult } from "../../commands/save.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspacePaths } from "../../index/reindex.ts";
import { logIntent } from "../../analysis/intent-log.ts";

export interface SaveArgs {
  name: string;
  source: string;
  /**
   * Required: a short (≥4 words) description of why the agent is persisting
   * this script. Goes into the intent log alongside run/search/query_types.
   */
  intent: string;
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
  if (!args.intent || !args.intent.trim()) {
    return {
      success: false,
      error:
        "save: `intent` is required. Provide a short sentence (≥4 words) " +
        "describing why you're persisting this script — it goes into the " +
        "intent log for session telemetry.",
    };
  }

  // Log intent before touching the filesystem so we capture attempts that
  // later fail typecheck (useful for debugging agent reasoning).
  try {
    logIntent({
      codeModeDir: resolveWorkspacePaths(workspaceDir).codeModeDir,
      tool: "save",
      intent: args.intent.trim(),
      meta: { name: args.name },
    });
  } catch {
    // Never fail a save because of telemetry.
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
