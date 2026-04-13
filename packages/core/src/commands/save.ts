/**
 * `code-mode save <name> --file <path> | --source -`
 *
 * Writes the script to `.code-mode/scripts/<name>.ts`, typechecks it inside the
 * workspace, and — on success — calls `reindex({ paths: [savedPath] })`.
 * On typecheck failure, the file is removed and diagnostics are returned.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { loadProject } from "../analysis/project.ts";
import { typecheckFile, type Diagnostic } from "../analysis/typecheck.ts";
import { reindex, resolveWorkspacePaths } from "../index/reindex.ts";

export interface SaveOptions {
  name?: string;
  file?: string;
  source?: boolean | string;
  overwrite?: boolean;
  path?: string;
  /** Test hook — return result instead of printing/exiting. */
  _returnResult?: boolean;
}

export interface SaveResult {
  success: boolean;
  path?: string;
  diagnostics?: Diagnostic[];
  error?: string;
}

export async function handler(opts: SaveOptions): Promise<SaveResult | void> {
  const workspaceDir = resolvePath(opts.path ?? process.cwd());
  const ws = resolveWorkspacePaths(workspaceDir);

  if (!opts.name) {
    return finish(opts, {
      success: false,
      error: "code-mode save: missing <name> positional",
    });
  }
  if (!opts.file && !(opts.source === "-" || opts.source === true)) {
    return finish(opts, {
      success: false,
      error: "code-mode save: pass either --file <path> or --source -",
    });
  }

  const source = await readSource(opts);
  const fileName = opts.name.endsWith(".ts") ? opts.name : `${opts.name}.ts`;
  const savedPath = isAbsolute(fileName)
    ? fileName
    : join(ws.scriptsDir, fileName);

  if (existsSync(savedPath) && !opts.overwrite) {
    return finish(opts, {
      success: false,
      error: `script already exists: ${savedPath} (pass --overwrite to replace)`,
    });
  }

  mkdirSync(dirname(savedPath), { recursive: true });
  writeFileSync(savedPath, source, "utf8");

  // Typecheck against the workspace project.
  let diagnostics: Diagnostic[] = [];
  try {
    const project = loadProject(workspaceDir);
    if (!project.getSourceFile(savedPath)) {
      project.addSourceFileAtPath(savedPath);
    }
    diagnostics = typecheckFile(project, savedPath).filter(
      (d) => d.severity === "error",
    );
  } catch (e) {
    // Treat loader failure as a fatal diagnostic.
    diagnostics = [
      {
        file: savedPath,
        line: 0,
        col: 0,
        code: 0,
        message: `failed to typecheck: ${(e as Error).message}`,
        severity: "error",
      },
    ];
  }

  if (diagnostics.length > 0) {
    // Remove the just-written file so the workspace doesn't accumulate
    // broken scripts.
    try {
      unlinkSync(savedPath);
    } catch {
      // ignore
    }
    return finish(opts, {
      success: false,
      diagnostics,
    });
  }

  // On success, hand off to the indexer so search/listSdks see it immediately.
  try {
    await reindex(workspaceDir, { paths: [savedPath] });
  } catch (e) {
    return finish(opts, {
      success: false,
      path: savedPath,
      error: `reindex failed: ${(e as Error).message}`,
    });
  }

  return finish(opts, {
    success: true,
    path: savedPath,
  });
}

async function readSource(opts: SaveOptions): Promise<string> {
  if (opts.file) {
    const abs = resolvePath(opts.file);
    if (!existsSync(abs)) {
      throw new Error(`--file not found: ${abs}`);
    }
    return readFileSync(abs, "utf8");
  }
  // stdin — node + bun both expose process.stdin as an async iterable of Buffer.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function finish(opts: SaveOptions, result: SaveResult): SaveResult | void {
  if (opts._returnResult) return result;
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.success) {
    process.exitCode = 1;
  }
}
