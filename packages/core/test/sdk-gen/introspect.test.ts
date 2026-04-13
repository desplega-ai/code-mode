import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { generateSdks } from "../../src/sdk-gen/index.ts";
import { introspectServer } from "../../src/sdk-gen/introspect.ts";

const FAKE_SERVER = resolve(__dirname, "..", "fixtures", "fake-mcp-server.ts");
const FIXED_NOW = () => new Date("2026-04-13T00:00:00.000Z");

describe("sdk-gen/introspect — fake stdio MCP fixture", () => {
  let tmpRoot: string;
  let sdksDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-sdkgen-e2e-"));
    sdksDir = join(tmpRoot, "sdks");
    mkdirSync(sdksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("introspects tools/list from the fake server", async () => {
    const res = await introspectServer(
      {
        name: "fake",
        transport: "stdio",
        command: "bun",
        args: ["run", FAKE_SERVER],
        sourcePath: "/fake",
      },
      { timeoutMs: 15_000 },
    );
    expect(res.ok).toBe(true);
    expect(res.tools.map((t) => t.name).sort()).toEqual([
      "create_issue",
      "list-labels",
      "ping",
    ]);
    const createIssue = res.tools.find((t) => t.name === "create_issue")!;
    expect(createIssue.outputSchema).toBeDefined();
  }, 30_000);

  test("failing MCP (bad command) records error, returns ok=false", async () => {
    const res = await introspectServer(
      {
        name: "broken",
        transport: "stdio",
        command: "/definitely/does/not/exist/bin",
        args: [],
        sourcePath: "/fake",
      },
      { timeoutMs: 5_000 },
    );
    expect(res.ok).toBe(false);
    expect(res.tools).toHaveLength(0);
    expect(res.error).toBeDefined();
  }, 15_000);

  test("generateSdks → emitted file passes tsc --noEmit with bun types", async () => {
    const rep = await generateSdks({
      workspaceDir: tmpRoot,
      sdksDir,
      specsOverride: [
        {
          name: "fake",
          transport: "stdio",
          command: "bun",
          args: ["run", FAKE_SERVER],
          sourcePath: "/fake",
        },
      ],
      timeoutMs: 15_000,
      now: FIXED_NOW,
    });
    expect(rep.emit.serverFiles).toHaveLength(1);

    // Typecheck the generated file in isolation. We scaffold a minimal
    // tsconfig that matches the workspace shape + writes the node_modules
    // from the repo into place via a pathing trick (symlink-free copy).
    // Simpler: run tsc from the repo root including the generated file.
    const repoRoot = resolve(__dirname, "..", "..");
    const tsconfigPath = join(tmpRoot, "tsconfig.json");
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: "esnext",
            module: "preserve",
            moduleResolution: "bundler",
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            skipLibCheck: true,
            resolveJsonModule: true,
            allowImportingTsExtensions: true,
            types: ["bun"],
            typeRoots: [join(repoRoot, "node_modules/@types")],
            baseUrl: tmpRoot,
            paths: {
              "@modelcontextprotocol/sdk/*": [
                join(repoRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/*"),
              ],
            },
          },
          include: [join(sdksDir, ".generated", "**/*.ts")],
        },
        null,
        2,
      ),
    );

    const tscBin = join(repoRoot, "node_modules", ".bin", "tsc");
    expect(existsSync(tscBin)).toBe(true);
    const out = spawnSync(tscBin, ["-p", tsconfigPath, "--noEmit"], {
      encoding: "utf8",
    });
    if (out.status !== 0) {
      // eslint-disable-next-line no-console
      console.error("tsc stdout:", out.stdout);
      // eslint-disable-next-line no-console
      console.error("tsc stderr:", out.stderr);
    }
    expect(out.status).toBe(0);
  }, 60_000);

  test("reindex does not crash when sdk-gen encounters a bad MCP command", async () => {
    // Run the generator with a bad spec; it must produce a valid empty
    // `.generated/` directory (client + empty registry) and skip the server.
    const rep = await generateSdks({
      workspaceDir: tmpRoot,
      sdksDir,
      specsOverride: [
        {
          name: "broken",
          transport: "stdio",
          command: "/no/such/bin",
          sourcePath: "/fake",
        },
      ],
      timeoutMs: 5_000,
      now: FIXED_NOW,
    });
    expect(rep.emit.skipped).toHaveLength(1);
    expect(rep.emit.serverFiles).toHaveLength(0);
    const registry = JSON.parse(
      readFileSync(join(sdksDir, ".generated", "_servers.json"), "utf8"),
    );
    expect(Object.keys(registry)).toHaveLength(0);
  }, 15_000);

  test("re-running generateSdks is idempotent byte-for-byte", async () => {
    const specs = [
      {
        name: "fake",
        transport: "stdio" as const,
        command: "bun",
        args: ["run", FAKE_SERVER],
        sourcePath: "/fake",
      },
    ];
    await generateSdks({ workspaceDir: tmpRoot, sdksDir, specsOverride: specs, now: FIXED_NOW });
    const first = readFileSync(join(sdksDir, ".generated", "fake.ts"));
    await generateSdks({ workspaceDir: tmpRoot, sdksDir, specsOverride: specs, now: FIXED_NOW });
    const second = readFileSync(join(sdksDir, ".generated", "fake.ts"));
    expect(Buffer.compare(first, second)).toBe(0);
  }, 60_000);
});
