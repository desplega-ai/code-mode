import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execScript, type RunResult } from "../../src/runner/exec.ts";
import type { Executor, ExecutorInput } from "../../src/runner/executor.ts";
import { BunExecutor } from "../../src/runner/bun-executor.ts";

function scaffoldWorkspace(root: string): string {
  const ws = join(root, "ws");
  const codeMode = join(ws, ".code-mode");
  const scripts = join(codeMode, "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(
    join(codeMode, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "esnext",
          module: "preserve",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
        },
        include: ["scripts/**/*.ts"],
      },
      null,
      2,
    ),
  );
  return ws;
}

describe("execScript: pluggable Executor", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-executor-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("delegates to a custom executor after typecheck passes", async () => {
    const ws = scaffoldWorkspace(tmpRoot);
    const scriptPath = join(ws, ".code-mode/scripts/ok.ts");
    writeFileSync(
      scriptPath,
      `export default async function main() { return 42 }`,
    );

    const calls: ExecutorInput[] = [];
    const fakeResult: RunResult = {
      success: true,
      result: "from-fake",
      logs: "",
      logsTruncated: false,
      exitCode: 0,
      durationMs: 1,
      reason: "ok",
      limits: {
        timeoutMs: 1,
        maxMemoryMb: 1,
        maxCpuSec: 1,
        maxOutputBytes: 1,
        maxArgsBytes: 1,
      },
    };
    const fake: Executor = {
      name: "fake",
      async execute(input) {
        calls.push(input);
        return fakeResult;
      },
    };

    const result = await execScript({
      workspaceDir: ws,
      entry: scriptPath,
      executor: fake,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.entryAbs).toBe(scriptPath);
    expect(calls[0]!.argsJson).toBe("null");
    expect(result.success).toBe(true);
    expect((result as { result: unknown }).result).toBe("from-fake");
  });

  test("does NOT call executor when typecheck fails", async () => {
    const ws = scaffoldWorkspace(tmpRoot);
    const scriptPath = join(ws, ".code-mode/scripts/broken.ts");
    writeFileSync(scriptPath, `const x: number = "not-a-number";\n`);

    let called = false;
    const fake: Executor = {
      name: "fake",
      async execute() {
        called = true;
        throw new Error("should not be called");
      },
    };

    const result = await execScript({
      workspaceDir: ws,
      entry: scriptPath,
      executor: fake,
    });

    expect(called).toBe(false);
    expect(result.success).toBe(false);
    expect((result as { reason?: string }).reason).toBe("typecheck");
  });

  test("default executor is BunExecutor", () => {
    const bun = new BunExecutor();
    expect(bun.name).toBe("bun");
  });
});
