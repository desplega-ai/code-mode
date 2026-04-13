/**
 * Tests for `code-mode init`.
 *
 * Specifically guards the v0.3.2 split-gating fix: even with `--no-install`,
 * the MCP SDK introspection step (`generateSdks`) must execute. Only the
 * ts-morph-dependent `reindex()` step is gated on `shouldInstall`.
 *
 * The MCP discovery would normally walk `~/.claude.json`, so each test sets
 * HOME to a clean tmpdir to keep results deterministic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handler as initHandler } from "../../src/commands/init.ts";

interface Captured {
  stdout: string[];
  stderr: string[];
}

function captureLogs(): { captured: Captured; restore: () => void } {
  const captured: Captured = { stdout: [], stderr: [] };
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    captured.stdout.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    captured.stderr.push(args.map(String).join(" "));
  };
  return {
    captured,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

describe("init --no-install gating", () => {
  let tmpRoot: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "cm-init-"));
    prevHome = process.env.HOME;
    // Isolate from real ~/.claude.json (which may register MCP servers).
    process.env.HOME = mkdtempSync(join(tmpdir(), "cm-init-home-"));
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("--no-install still runs MCP SDK generation (logs 'generated N MCP SDK(s)')", async () => {
    const target = join(tmpRoot, "ws");
    mkdirSync(target);

    const { captured, restore } = captureLogs();
    try {
      await initHandler({ path: target, install: false });
    } finally {
      restore();
    }

    const all = captured.stdout.join("\n");

    // Generation step ran (regardless of count — there are no MCPs in this
    // scratch HOME, so the count will be 0, but the log line proves the
    // code path executed).
    expect(all).toMatch(/generated \d+ MCP SDK\(s\)/);

    // The follow-up "run reindex after bun install" line is the new
    // --no-install hint that distinguishes 0.3.2 behavior.
    expect(all).toMatch(/Run 'code-mode reindex' after 'bun install'/);

    // The skip-install banner still fires.
    expect(all).toMatch(/skipped dependency install/);

    // Workspace was scaffolded.
    expect(existsSync(join(target, ".code-mode", "tsconfig.json"))).toBe(true);
    expect(existsSync(join(target, ".code-mode", "sdks", "stdlib", "fetch.ts"))).toBe(
      true,
    );
    expect(existsSync(join(target, ".code-mode", "sdks", ".generated"))).toBe(true);
  });

  test("--no-install with a project-local .mcp.json still introspects (or fails non-fatally)", async () => {
    const target = join(tmpRoot, "ws-mcp");
    mkdirSync(target);
    // Register a bogus stdio server. introspect will fail because the
    // command doesn't exist, but the failure must be non-fatal — init still
    // completes and logs the "generated N MCP SDK(s)" line.
    writeFileSync(
      join(target, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "fake-server": {
            command: "/nonexistent/binary-that-will-fail",
            args: [],
          },
        },
      }),
    );

    const { captured, restore } = captureLogs();
    try {
      await initHandler({ path: target, install: false });
    } finally {
      restore();
    }

    const all = captured.stdout.join("\n") + "\n" + captured.stderr.join("\n");
    expect(all).toMatch(/generated \d+ MCP SDK\(s\)/);
    // Still terminates cleanly with the "done." marker.
    expect(captured.stdout.join("\n")).toMatch(/\[code-mode init\] done\./);
  });
});
