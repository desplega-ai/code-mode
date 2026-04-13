/**
 * Unit tests for the plugin's smart-resolver (plugins/code-mode/lib/resolver.mjs).
 *
 * The resolver is pure — it never spawns — so we drive it with injected
 * filesystem + resolver stubs and assert on the returned descriptor.
 *
 * Matrix (per Phase 1 of the plan):
 *   - CODE_MODE_DEV_PATH valid → kind="dev", path preserved.
 *   - CODE_MODE_DEV_PATH points at missing file → kind="error".
 *   - Project-local install present → kind="project".
 *   - Only global install present → kind="global".
 *   - Nothing available → kind="npx" (what start.mjs would fall back to).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// @ts-expect-error — plain .mjs module outside the TS project; bun resolves it fine.
import { resolveEntry } from "../../../../plugins/code-mode/lib/resolver.mjs";

type Entry = {
  kind: "dev" | "project" | "global" | "npx" | "error";
  path?: string;
  reason?: string;
};

function makeFileExists(known: Set<string>) {
  return (p: string) => known.has(p);
}

const CWD = "/workspace";
const HOME = "/home/taras";

describe("start-resolver", () => {
  test("CODE_MODE_DEV_PATH valid → kind=dev with preserved path", () => {
    const dev = "/abs/dist/cli.js";
    const result: Entry = resolveEntry({
      env: { CODE_MODE_DEV_PATH: dev },
      cwd: CWD,
      home: HOME,
      fileExists: makeFileExists(new Set([dev])),
      resolveFrom: () => null,
    });
    expect(result.kind).toBe("dev");
    expect(result.path).toBe(dev);
  });

  test("CODE_MODE_DEV_PATH points at missing file → kind=error, no fallthrough", () => {
    const dev = "/abs/missing/cli.js";
    const result: Entry = resolveEntry({
      env: { CODE_MODE_DEV_PATH: dev },
      cwd: CWD,
      home: HOME,
      // project-local + global are both "available" — dev error must still win,
      // otherwise a dev pointing at a broken path would silently get a stale install.
      fileExists: makeFileExists(
        new Set([
          join(CWD, "node_modules/@desplega/code-mode/dist/cli.js"),
          "/global/pkg/dist/cli.js",
        ]),
      ),
      resolveFrom: (_from: string, spec: string) =>
        spec === "@desplega/code-mode/package.json"
          ? "/global/pkg/package.json"
          : null,
    });
    expect(result.kind).toBe("error");
    expect(result.reason).toContain(dev);
    expect(result.reason).toMatch(/missing/i);
  });

  test("CODE_MODE_DEV_PATH non-absolute → kind=error", () => {
    const result: Entry = resolveEntry({
      env: { CODE_MODE_DEV_PATH: "relative/cli.js" },
      cwd: CWD,
      home: HOME,
      fileExists: () => true,
      resolveFrom: () => null,
    });
    expect(result.kind).toBe("error");
    expect(result.reason).toMatch(/absolute/i);
  });

  test("no dev path, project-local present → kind=project", () => {
    const local = join(CWD, "node_modules/@desplega/code-mode/dist/cli.js");
    const result: Entry = resolveEntry({
      env: {},
      cwd: CWD,
      home: HOME,
      fileExists: makeFileExists(new Set([local])),
      resolveFrom: () => null,
    });
    expect(result.kind).toBe("project");
    expect(result.path).toBe(local);
  });

  test("only global install present → kind=global", () => {
    const globalPkg = "/global/lib/node_modules/@desplega/code-mode/package.json";
    const globalCli = "/global/lib/node_modules/@desplega/code-mode/dist/cli.js";
    const result: Entry = resolveEntry({
      env: {},
      cwd: CWD,
      home: HOME,
      fileExists: makeFileExists(new Set([globalCli])),
      resolveFrom: (_from: string, spec: string) =>
        spec === "@desplega/code-mode/package.json" ? globalPkg : null,
    });
    expect(result.kind).toBe("global");
    expect(result.path).toBe(globalCli);
  });

  test("global resolves but dist/cli.js missing → kind=npx", () => {
    // E.g. someone installed a package that lost its build; don't blow up,
    // just fall through to npx.
    const globalPkg = "/global/pkg/package.json";
    const result: Entry = resolveEntry({
      env: {},
      cwd: CWD,
      home: HOME,
      fileExists: makeFileExists(new Set()), // nothing exists
      resolveFrom: (_from: string, spec: string) =>
        spec === "@desplega/code-mode/package.json" ? globalPkg : null,
    });
    expect(result.kind).toBe("npx");
  });

  test("nothing available → kind=npx", () => {
    const result: Entry = resolveEntry({
      env: {},
      cwd: CWD,
      home: HOME,
      fileExists: () => false,
      resolveFrom: () => null,
    });
    expect(result.kind).toBe("npx");
  });

  test("project-local wins over global when both are available", () => {
    const local = join(CWD, "node_modules/@desplega/code-mode/dist/cli.js");
    const globalPkg = "/global/pkg/package.json";
    const globalCli = "/global/pkg/dist/cli.js";
    const result: Entry = resolveEntry({
      env: {},
      cwd: CWD,
      home: HOME,
      fileExists: makeFileExists(new Set([local, globalCli])),
      resolveFrom: (_from: string, spec: string) =>
        spec === "@desplega/code-mode/package.json" ? globalPkg : null,
    });
    expect(result.kind).toBe("project");
    expect(result.path).toBe(local);
  });
});
