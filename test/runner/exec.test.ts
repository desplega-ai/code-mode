import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execScript } from "../../src/runner/exec.ts";
import { loadProject } from "../../src/analysis/project.ts";

/**
 * Build a .code-mode/-shaped tree on disk so typecheck + spawn both see it.
 * Unlike the reindex suite, we CAN'T use the in-memory FS here — the child
 * subprocess needs real files.
 */
function scaffoldWorkspace(root: string): string {
  const ws = join(root, "ws");
  const codeMode = join(ws, ".code-mode");
  const sdks = join(codeMode, "sdks", "stdlib");
  const scripts = join(codeMode, "scripts");
  mkdirSync(sdks, { recursive: true });
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
          baseUrl: ".",
          paths: { "@/*": ["./*"] },
        },
        include: ["scripts/**/*.ts", "sdks/**/*.ts"],
      },
      null,
      2,
    ),
  );

  // Minimal stdlib fixture — a real script will import from this.
  writeFileSync(
    join(sdks, "filter.ts"),
    `export function filter<T>(items: T[], pred: (t: T) => boolean): T[] {
  return items.filter(pred);
}
`,
  );

  return ws;
}

describe("execScript: typecheck gate", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-run-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("broken inline run returns diagnostics, does not spawn", async () => {
    const ws = scaffoldWorkspace(tmpRoot);
    const entry = join(ws, ".code-mode", "scripts", "broken.ts");
    writeFileSync(
      entry,
      `export default async function main(args: unknown) {
  const n: number = "not a number"; // TS error
  return n;
}
`,
    );

    const result = await execScript({
      workspaceDir: ws,
      entry,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("typecheck");
      expect(result.diagnostics?.length).toBeGreaterThan(0);
      expect(result.diagnostics?.[0]?.message).toContain("not assignable");
      expect(result.logs).toBeUndefined();
    }
  });

  test("oversize argsJson is rejected pre-spawn", async () => {
    const ws = scaffoldWorkspace(tmpRoot);
    const entry = join(ws, ".code-mode", "scripts", "ok.ts");
    writeFileSync(
      entry,
      `export default async function main(_args: unknown) { return 1; }
`,
    );

    const huge = JSON.stringify({ blob: "x".repeat(300 * 1024) });
    const started = Date.now();
    const result = await execScript({
      workspaceDir: ws,
      entry,
      argsJson: huge,
    });
    const elapsed = Date.now() - started;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("argscap");
    }
    // Fail fast — no spawn, so should be well under any run timeout.
    expect(elapsed).toBeLessThan(500);
  });
});

describe("execScript: happy path", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-run-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("runs a stdlib-using script and returns structured result", async () => {
    const ws = scaffoldWorkspace(tmpRoot);
    const entry = join(ws, ".code-mode", "scripts", "sum.ts");
    writeFileSync(
      entry,
      `import { filter } from "../sdks/stdlib/filter.ts";

interface SumArgs { numbers: number[]; }

export default async function main(args: SumArgs) {
  const positives = filter(args.numbers, (n) => n > 0);
  return { count: positives.length, sum: positives.reduce((a, b) => a + b, 0) };
}
`,
    );

    const result = await execScript({
      workspaceDir: ws,
      entry,
      argsJson: JSON.stringify({ numbers: [1, -2, 3, -4, 5] }),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({ count: 3, sum: 9 });
      expect(result.reason).toBe("ok");
      expect(result.exitCode).toBe(0);
    }
  }, 15_000);

  test("captures logs separately from the sentinel result", async () => {
    const ws = scaffoldWorkspace(tmpRoot);
    const entry = join(ws, ".code-mode", "scripts", "logs.ts");
    writeFileSync(
      entry,
      `export default async function main(_args: unknown) {
  console.log("hello from script");
  console.error("warning path");
  return 42;
}
`,
    );

    const result = await execScript({
      workspaceDir: ws,
      entry,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toBe(42);
      expect(result.logs).toContain("hello from script");
      expect(result.logs).toContain("warning path");
    }
  }, 15_000);
});

describe("execScript: limits", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-run-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("timeout kills a runaway script", async () => {
    const ws = scaffoldWorkspace(tmpRoot);
    const entry = join(ws, ".code-mode", "scripts", "loop.ts");
    writeFileSync(
      entry,
      `export default async function main(_args: unknown) {
  while (true) {
    // busy loop — exits only via timeout
  }
}
`,
    );

    const started = Date.now();
    const result = await execScript({
      workspaceDir: ws,
      entry,
      limits: { timeoutMs: 1_000 },
    });
    const elapsed = Date.now() - started;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("timeout");
    }
    // Should kill within timeout + generous margin.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  test.skipIf(process.platform !== "linux")(
    "memory cap kills an over-allocating script (Linux only — macOS ulimit -v is advisory)",
    async () => {
      const ws = scaffoldWorkspace(tmpRoot);
      const entry = join(ws, ".code-mode", "scripts", "greedy.ts");
      writeFileSync(
        entry,
        `export default async function main(_args: unknown) {
  const buffers: Uint8Array[] = [];
  // Try to allocate ~200MB — should exceed the --max-memory=32 cap below.
  for (let i = 0; i < 200; i++) {
    buffers.push(new Uint8Array(1024 * 1024));
  }
  return buffers.length;
}
`,
      );

      const result = await execScript({
        workspaceDir: ws,
        entry,
        limits: { maxMemoryMb: 32, timeoutMs: 10_000 },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(["memory", "crash"]).toContain(result.reason ?? "unknown");
      }
    },
    30_000,
  );

  test("output cap truncates large stdout with marker", async () => {
    const ws = scaffoldWorkspace(tmpRoot);
    const entry = join(ws, ".code-mode", "scripts", "noisy.ts");
    writeFileSync(
      entry,
      `export default async function main(_args: unknown) {
  // Write ~2MB of stdout, then return a tiny result.
  const chunk = "a".repeat(64 * 1024);
  for (let i = 0; i < 32; i++) {
    console.log(chunk);
  }
  return { ok: true };
}
`,
    );

    const result = await execScript({
      workspaceDir: ws,
      entry,
      limits: { maxOutputBytes: 100_000 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.logsTruncated).toBe(true);
      expect(result.logs).toContain("[truncated]");
    }
  }, 20_000);
});
