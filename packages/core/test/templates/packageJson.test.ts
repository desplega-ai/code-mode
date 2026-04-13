/**
 * Regression guard for the init scaffold (v0.3.3, Bug B).
 *
 * The emitted `.code-mode/package.json` must declare
 * `@modelcontextprotocol/sdk` as a runtime dependency — not devDependency —
 * because the generated `_client.ts` dynamically imports it at tool-call time.
 */

import { describe, expect, test } from "bun:test";
import { packageJson } from "../../src/templates/package.json.ts";

describe("packageJson template", () => {
  test("declares @modelcontextprotocol/sdk as a runtime dependency", () => {
    const pkg = JSON.parse(packageJson()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    // Runtime dep: used by generated `_client.ts` via dynamic import.
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies?.["@modelcontextprotocol/sdk"]).toBeDefined();
    // Pinned to ^1.x to match packages/core's own dep.
    expect(pkg.dependencies?.["@modelcontextprotocol/sdk"]).toMatch(/^\^1\./);

    // Must NOT live in devDependencies — dev-only would drop it in prod
    // installs and break `code-mode run`.
    expect(
      pkg.devDependencies?.["@modelcontextprotocol/sdk"],
    ).toBeUndefined();
  });

  test("preserves existing devDependencies (bun-types, typescript)", () => {
    const pkg = JSON.parse(packageJson()) as {
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.["bun-types"]).toBeDefined();
    expect(pkg.devDependencies?.typescript).toBeDefined();
  });
});
