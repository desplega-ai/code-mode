import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitGeneratedSdks } from "../../src/sdk-gen/emit.ts";
import type { IntrospectResult } from "../../src/sdk-gen/introspect.ts";

const SNAPSHOT_DIR = resolve(__dirname, "..", "fixtures", "snapshots");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
const FIXED_NOW = () => new Date("2026-04-13T00:00:00.000Z");

const INTROSPECT: IntrospectResult = {
  spec: {
    name: "github",
    transport: "stdio",
    command: "bun",
    args: ["run", "gh.ts"],
    sourcePath: "/fake",
  },
  ok: true,
  tools: [
    {
      name: "create_issue",
      description: "Create a GitHub issue.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          body: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
          priority: { enum: ["low", "medium", "high"] },
          assignee: { $ref: "#/definitions/User" },
        },
        required: ["title"],
        definitions: {
          User: {
            type: "object",
            properties: {
              login: { type: "string" },
              id: { type: "integer" },
            },
            required: ["login"],
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: { number: { type: "integer" }, url: { type: "string" } },
        required: ["number", "url"],
      },
    },
    {
      name: "ping",
      description: "Health ping.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

function compareOrUpdate(name: string, actual: string): void {
  const path = join(SNAPSHOT_DIR, name);
  if (UPDATE || !existsSync(path)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  const expected = readFileSync(path, "utf8");
  expect(actual).toBe(expected);
}

describe("sdk-gen/snapshot — golden output", () => {
  let tmpRoot: string;
  let sdksDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "code-mode-sdkgen-snap-"));
    sdksDir = join(tmpRoot, "sdks");
    mkdirSync(sdksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("github.ts module body matches snapshot", async () => {
    await emitGeneratedSdks([INTROSPECT], { sdksDir, now: FIXED_NOW });
    const actual = readFileSync(join(sdksDir, ".generated", "github.ts"), "utf8");
    compareOrUpdate("github.ts", actual);
  });

  test("_client.ts runtime matches snapshot", async () => {
    await emitGeneratedSdks([INTROSPECT], { sdksDir, now: FIXED_NOW });
    const actual = readFileSync(join(sdksDir, ".generated", "_client.ts"), "utf8");
    compareOrUpdate("_client.ts", actual);
  });

  test("_servers.json matches snapshot", async () => {
    await emitGeneratedSdks([INTROSPECT], { sdksDir, now: FIXED_NOW });
    const actual = readFileSync(join(sdksDir, ".generated", "_servers.json"), "utf8");
    compareOrUpdate("_servers.json", actual);
  });
});
