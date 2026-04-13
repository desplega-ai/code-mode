// Smart-resolver for the @desplega/code-mode CLI entrypoint.
//
// Pure function: never spawns, never logs. Returns a descriptor describing
// how a caller should invoke the CLI. `start.mjs` wraps this with spawn
// + stderr logging.
//
// Resolution priority (first hit wins):
//   1. CODE_MODE_DEV_PATH env → absolute path to a dist/cli.js. If set but
//      the file is missing, we return `{ kind: "error", reason }` — no
//      silent fallthrough, because a dev pointing at a broken path wants
//      to know immediately.
//   2. <cwd>/node_modules/@desplega/code-mode/dist/cli.js — project-local.
//   3. require.resolve("@desplega/code-mode/package.json") from ${HOME} →
//      join with dist/cli.js. We resolve package.json (not the bare
//      specifier) because the package's "main" is dist/lib.js; we need the
//      CLI entry explicitly.
//   4. npx -y @desplega/code-mode@latest — cold-machine fallback
//      (the `@latest` pin is required; bare `@desplega/code-mode` hits an
//      npx bin-linking quirk for scoped packages — see start.mjs#runNpx).

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, isAbsolute } from "node:path";

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.cwd]
 * @param {string} [opts.home]
 * @param {(p: string) => boolean} [opts.fileExists]  // injectable for tests
 * @param {(from: string, spec: string) => string | null} [opts.resolveFrom]  // injectable for tests
 * @returns {{ kind: "dev"|"project"|"global"|"npx"|"error", path?: string, reason?: string }}
 */
export function resolveEntry(opts = {}) {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? env.HOME ?? env.USERPROFILE ?? "/";
  const fileExists = opts.fileExists ?? existsSync;
  const resolveFrom = opts.resolveFrom ?? defaultResolveFrom;

  // 1. Dev path
  const devPath = env.CODE_MODE_DEV_PATH;
  if (devPath && devPath.length > 0) {
    if (!isAbsolute(devPath)) {
      return {
        kind: "error",
        reason: `CODE_MODE_DEV_PATH must be absolute, got: ${devPath}`,
      };
    }
    if (!fileExists(devPath)) {
      return {
        kind: "error",
        reason: `CODE_MODE_DEV_PATH points at missing file: ${devPath}`,
      };
    }
    return { kind: "dev", path: devPath };
  }

  // 2. Project-local
  const projectLocal = join(
    cwd,
    "node_modules",
    "@desplega",
    "code-mode",
    "dist",
    "cli.js",
  );
  if (fileExists(projectLocal)) {
    return { kind: "project", path: projectLocal };
  }

  // 3. Global via Node resolution from $HOME
  //    Resolve the package.json (stable regardless of "main"/"exports"),
  //    then walk to dist/cli.js.
  try {
    const pkgJson = resolveFrom(home, "@desplega/code-mode/package.json");
    if (pkgJson) {
      const cli = join(dirname(pkgJson), "dist", "cli.js");
      if (fileExists(cli)) {
        return { kind: "global", path: cli };
      }
    }
  } catch {
    // fall through to npx
  }

  // 4. npx fallback
  return { kind: "npx" };
}

function defaultResolveFrom(from, spec) {
  try {
    // createRequire needs a file-URL-ish path; a directory with a trailing
    // slash works because Node treats it as a directory context.
    const req = createRequire(join(from, "noop.js"));
    return req.resolve(spec);
  } catch {
    return null;
  }
}
