/**
 * ts-morph `Project` loader for a code-mode workspace.
 *
 * Creates a single `Project` rooted at the workspace's `.code-mode/tsconfig.json`.
 * Callers should share a `Project` across many extract/typecheck calls to amortize
 * startup cost.
 *
 * Memory management: use `scopedExtract` to run per-file work inside a block that
 * automatically calls `forgetNodesCreatedInBlock()` afterwards — this prevents the
 * compiler cache from growing unboundedly across a large bulk index run.
 */

import * as path from "node:path";
import { Project } from "ts-morph";

/**
 * Options for `loadProject`. `inMemory` is used by tests (no filesystem I/O).
 */
export interface LoadProjectOptions {
  /** If true, create an in-memory virtual filesystem (for tests). */
  inMemory?: boolean;
  /**
   * Override the tsconfig path. If omitted and `inMemory` is false, defaults to
   * `<workspaceDir>/.code-mode/tsconfig.json`.
   */
  tsConfigFilePath?: string;
}

/**
 * Load a ts-morph `Project` for a given workspace directory.
 *
 * For real workspaces this reads `.code-mode/tsconfig.json` off disk. For tests
 * pass `inMemory: true` and add source files via `project.createSourceFile(...)`.
 */
export function loadProject(
  workspaceDir: string,
  opts: LoadProjectOptions = {},
): Project {
  if (opts.inMemory) {
    return new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: 99, // ESNext
        module: 200, // Preserve — matches the workspace tsconfig
        moduleResolution: 100, // Bundler
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
      },
    });
  }

  const tsConfigFilePath =
    opts.tsConfigFilePath ??
    path.join(workspaceDir, ".code-mode", "tsconfig.json");

  return new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: false,
  });
}

/**
 * Run `fn` and then call `project.getProject()?.forgetNodesCreatedInBlock()` so
 * callers cannot accidentally leak compiler nodes across files.
 *
 * Use this for any per-file analysis inside a bulk indexer.
 */
export function scopedExtract<T>(project: Project, fn: () => T): T {
  let result!: T;
  project.forgetNodesCreatedInBlock(() => {
    result = fn();
  });
  return result;
}
