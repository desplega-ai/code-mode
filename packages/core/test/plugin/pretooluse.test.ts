/**
 * Tests for `plugins/code-mode/hooks/pretooluse.mjs`.
 *
 * Shells out to `node pretooluse.mjs` with crafted stdin payloads and
 * asserts on emitted JSON. Each test uses a fresh per-test TMPDIR so
 * dedup state never leaks between cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOK_PATH = resolve(
  import.meta.dir,
  "../../../..",
  "plugins/code-mode/hooks/pretooluse.mjs",
);

interface HookResult {
  stdoutRaw: string;
  parsed: any;
  status: number | null;
}

interface RunOpts {
  env?: Record<string, string>;
  cwd?: string;
  sessionId?: string;
}

function runHook(payload: unknown, opts: RunOpts = {}): HookResult {
  const env = {
    ...process.env,
    TMPDIR: opts.env?.TMPDIR ?? process.env.TMPDIR,
    // Scrub by default; allow caller to re-inject.
    CODE_MODE_SKIP: "",
    CODE_MODE_MCP_BLOCK: "",
    ...(opts.env ?? {}),
  };
  const result = spawnSync("node", [HOOK_PATH], {
    input: JSON.stringify({
      session_id: opts.sessionId ?? "s-test",
      cwd: opts.cwd ?? process.cwd(),
      ...(typeof payload === "object" && payload !== null ? payload : {}),
    }),
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  const stdoutRaw = result.stdout ?? "";
  let parsed: any = {};
  try {
    parsed = stdoutRaw.length > 0 ? JSON.parse(stdoutRaw) : {};
  } catch {
    parsed = { __parseError: true, stdoutRaw };
  }
  return { stdoutRaw, parsed, status: result.status };
}

function makeTmpdir(): string {
  return mkdtempSync(join(tmpdir(), "cm-hook-"));
}

function makeWorkspace(cfg?: object): string {
  const ws = mkdtempSync(join(tmpdir(), "cm-hook-ws-"));
  if (cfg) {
    mkdirSync(join(ws, ".code-mode"), { recursive: true });
    writeFileSync(
      join(ws, ".code-mode", "config.json"),
      JSON.stringify(cfg, null, 2) + "\n",
      "utf8",
    );
  }
  return ws;
}

describe("pretooluse hook — basic dispatch", () => {
  let isolatedTmp: string;

  beforeEach(() => {
    isolatedTmp = makeTmpdir();
  });

  afterEach(() => {
    rmSync(isolatedTmp, { recursive: true, force: true });
  });

  test("WebFetch → allow with non-empty additionalContext", () => {
    const r = runHook(
      { tool_name: "WebFetch", tool_input: { url: "https://example.com" } },
      { env: { TMPDIR: isolatedTmp }, sessionId: "s-webfetch" },
    );
    expect(r.status).toBe(0);
    expect(r.parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(r.parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(r.parsed.hookSpecificOutput.additionalContext).toBeTruthy();
    expect(r.parsed.hookSpecificOutput.additionalContext).toMatch(/fetch/i);
    expect(r.parsed.hookSpecificOutput.additionalContext).toMatch(
      /mcp__plugin_code-mode_code-mode__run/,
    );
  });

  test("Bash inline-exec (bun -e) → ask with reason mentioning save", () => {
    const r = runHook(
      {
        tool_name: "Bash",
        tool_input: { command: "bun -e 'console.log(1)'" },
      },
      { env: { TMPDIR: isolatedTmp }, sessionId: "s-bash-bune" },
    );
    expect(r.parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(r.parsed.hookSpecificOutput.permissionDecisionReason).toMatch(
      /save/,
    );
  });

  test("Bash benign (ls -la) → allow with generic hint", () => {
    const r = runHook(
      { tool_name: "Bash", tool_input: { command: "ls -la" } },
      { env: { TMPDIR: isolatedTmp }, sessionId: "s-bash-ls" },
    );
    expect(r.parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(r.parsed.hookSpecificOutput.additionalContext).toBeTruthy();
    // Generic hint mentions code-mode
    expect(r.parsed.hookSpecificOutput.additionalContext).toMatch(/code-mode/);
  });

  test("Bash inline-exec variants all → ask", () => {
    const variants = [
      "python -c 'print(1)'",
      "python3 -c 'print(1)'",
      "node -e 'console.log(1)'",
      "node --eval 'console.log(1)'",
      "deno eval 'console.log(1)'",
      "ruby -e 'puts 1'",
      "perl -e 'print 1'",
      "node <<< 'console.log(1)'",
      "python3 <<EOF\nprint(1)\nEOF",
    ];
    for (const [i, command] of variants.entries()) {
      const r = runHook(
        { tool_name: "Bash", tool_input: { command } },
        {
          env: { TMPDIR: isolatedTmp },
          sessionId: `s-bash-var-${i}`,
        },
      );
      expect(
        r.parsed.hookSpecificOutput?.permissionDecision,
      ).toBe("ask");
    }
  });
});

describe("pretooluse hook — MCP dispatch", () => {
  let isolatedTmp: string;

  beforeEach(() => {
    isolatedTmp = makeTmpdir();
  });

  afterEach(() => {
    rmSync(isolatedTmp, { recursive: true, force: true });
  });

  test("whitelisted context7 tool with default config → silent pass", () => {
    const ws = makeWorkspace();
    const r = runHook(
      { tool_name: "mcp__context7__resolve-library-id", tool_input: {} },
      {
        env: { TMPDIR: isolatedTmp },
        cwd: ws,
        sessionId: "s-c7",
      },
    );
    expect(r.parsed).toEqual({});
    rmSync(ws, { recursive: true, force: true });
  });

  test("whitelisted context7 tool + CODE_MODE_MCP_BLOCK=1 → still silent pass (whitelist wins)", () => {
    const ws = makeWorkspace();
    const r = runHook(
      { tool_name: "mcp__context7__resolve-library-id", tool_input: {} },
      {
        env: { TMPDIR: isolatedTmp, CODE_MODE_MCP_BLOCK: "1" },
        cwd: ws,
        sessionId: "s-c7-block",
      },
    );
    expect(r.parsed).toEqual({});
    rmSync(ws, { recursive: true, force: true });
  });

  test("non-whitelisted github tool default config → allow + whitelist hint", () => {
    const ws = makeWorkspace();
    const r = runHook(
      { tool_name: "mcp__github__create_issue", tool_input: {} },
      {
        env: { TMPDIR: isolatedTmp },
        cwd: ws,
        sessionId: "s-gh-hint",
      },
    );
    expect(r.parsed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(r.parsed.hookSpecificOutput.additionalContext).toMatch(
      /code-mode config whitelist add/,
    );
    rmSync(ws, { recursive: true, force: true });
  });

  test("non-whitelisted github tool + CODE_MODE_MCP_BLOCK=1 → deny with reason", () => {
    const ws = makeWorkspace();
    const r = runHook(
      { tool_name: "mcp__github__create_issue", tool_input: {} },
      {
        env: { TMPDIR: isolatedTmp, CODE_MODE_MCP_BLOCK: "1" },
        cwd: ws,
        sessionId: "s-gh-block",
      },
    );
    expect(r.parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = r.parsed.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toMatch(/mcp__github__create_issue/);
    expect(reason).toMatch(/whitelist/);
    expect(reason).toMatch(/CODE_MODE_MCP_BLOCK=0/);
    rmSync(ws, { recursive: true, force: true });
  });

  test("non-whitelisted MCP tool with a generated SDK → deny + typed snippet", () => {
    const ws = makeWorkspace({
      mcpBlockMode: "block",
      mcpWhitelist: [],
      hooksEnabled: true,
    });
    // Seed a generated SDK for a fake `dbhub` server.
    const genDir = join(ws, ".code-mode", "sdks", ".generated");
    mkdirSync(genDir, { recursive: true });
    writeFileSync(
      join(genDir, "dbhub.ts"),
      `import { callTool } from "./_client";
export interface ExecuteSqlArgs { sql: string }
export type ExecuteSqlResult = unknown;
export async function executeSql(args: ExecuteSqlArgs): Promise<ExecuteSqlResult> {
  return callTool("dbhub", "execute_sql", args as unknown as Record<string, unknown>) as Promise<ExecuteSqlResult>;
}

export interface SearchObjectsArgs { pattern: string }
export type SearchObjectsResult = unknown;
export async function searchObjects(args: SearchObjectsArgs): Promise<SearchObjectsResult> {
  return callTool("dbhub", "search_objects", args as unknown as Record<string, unknown>) as Promise<SearchObjectsResult>;
}
`,
      "utf8",
    );

    const r = runHook(
      { tool_name: "mcp__dbhub__execute_sql", tool_input: { sql: "SELECT 1" } },
      {
        env: { TMPDIR: isolatedTmp, CODE_MODE_MCP_BLOCK: "1" },
        cwd: ws,
        sessionId: "s-dbhub-block",
      },
    );
    expect(r.parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = r.parsed.hookSpecificOutput.permissionDecisionReason;
    // Typed snippet markers.
    expect(reason).toMatch(/import \{ executeSql \}/);
    expect(reason).toMatch(/@\/sdks\/\.generated\/dbhub/);
    expect(reason).toMatch(/mcp__plugin_code-mode_code-mode__run/);
    expect(reason).toMatch(/Other dbhub tools:.*searchObjects/);
    expect(reason).toMatch(/code-mode config whitelist add mcp__dbhub__/);
    rmSync(ws, { recursive: true, force: true });
  });

  test("non-whitelisted MCP tool with NO generated SDK → deny + generic message", () => {
    const ws = makeWorkspace({
      mcpBlockMode: "block",
      mcpWhitelist: [],
      hooksEnabled: true,
    });
    const r = runHook(
      { tool_name: "mcp__ghostsvc__frobnicate", tool_input: {} },
      {
        env: { TMPDIR: isolatedTmp, CODE_MODE_MCP_BLOCK: "1" },
        cwd: ws,
        sessionId: "s-ghost-block",
      },
    );
    expect(r.parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = r.parsed.hookSpecificOutput.permissionDecisionReason;
    // Must NOT include a typed-import line, should fall back to the generic.
    expect(reason).not.toMatch(/import \{/);
    expect(reason).toMatch(/is not whitelisted and mcpBlockMode=block/);
    expect(reason).toMatch(/stdlib\//);
    rmSync(ws, { recursive: true, force: true });
  });

  test("code-mode's own MCP tool → silent pass regardless of config", () => {
    const ws = makeWorkspace({
      mcpBlockMode: "block",
      mcpWhitelist: [],
      hooksEnabled: true,
    });
    const r = runHook(
      {
        tool_name: "mcp__plugin_code-mode_code-mode__search",
        tool_input: {},
      },
      {
        env: { TMPDIR: isolatedTmp },
        cwd: ws,
        sessionId: "s-own",
      },
    );
    expect(r.parsed).toEqual({});
    rmSync(ws, { recursive: true, force: true });
  });

  test("custom whitelist allows a prefix", () => {
    const ws = makeWorkspace({
      mcpBlockMode: "block",
      mcpWhitelist: ["mcp__github__"],
      hooksEnabled: true,
    });
    const r = runHook(
      { tool_name: "mcp__github__create_issue", tool_input: {} },
      {
        env: { TMPDIR: isolatedTmp },
        cwd: ws,
        sessionId: "s-gh-wl",
      },
    );
    expect(r.parsed).toEqual({});
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("pretooluse hook — dedup + escape hatches", () => {
  let isolatedTmp: string;

  beforeEach(() => {
    isolatedTmp = makeTmpdir();
  });

  afterEach(() => {
    rmSync(isolatedTmp, { recursive: true, force: true });
  });

  test("second call same session same tool → silent pass (dedup)", () => {
    const r1 = runHook(
      { tool_name: "WebFetch", tool_input: { url: "https://a" } },
      { env: { TMPDIR: isolatedTmp }, sessionId: "s-dedup" },
    );
    expect(r1.parsed.hookSpecificOutput.permissionDecision).toBe("allow");

    const r2 = runHook(
      { tool_name: "WebFetch", tool_input: { url: "https://b" } },
      { env: { TMPDIR: isolatedTmp }, sessionId: "s-dedup" },
    );
    expect(r2.parsed).toEqual({});
  });

  test("CODE_MODE_SKIP=1 → silent pass on any tool", () => {
    for (const toolName of ["WebFetch", "Bash", "mcp__github__create_issue"]) {
      const r = runHook(
        { tool_name: toolName, tool_input: { command: "bun -e 'x'" } },
        {
          env: { TMPDIR: isolatedTmp, CODE_MODE_SKIP: "1" },
          sessionId: `s-skip-${toolName}`,
        },
      );
      expect(r.parsed).toEqual({});
    }
  });

  test("malformed stdin → silent pass", () => {
    const result = spawnSync("node", [HOOK_PATH], {
      input: "not json at all {",
      env: {
        ...process.env,
        TMPDIR: isolatedTmp,
        CODE_MODE_SKIP: "",
        CODE_MODE_MCP_BLOCK: "",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("{}");
  });

  test("missing tool_name → silent pass", () => {
    const r = runHook(
      { tool_input: { command: "ls" } },
      { env: { TMPDIR: isolatedTmp }, sessionId: "s-notool" },
    );
    expect(r.parsed).toEqual({});
  });
});
