import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactIntentLog,
  logIntent,
  readIntentLog,
} from "../../src/analysis/intent-log.ts";

describe("intent-log", () => {
  let tmp: string;
  let cmd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "code-mode-intent-log-test-"));
    cmd = join(tmp, ".code-mode");
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("appends a single entry with ts + tool + intent", () => {
    logIntent({
      codeModeDir: cmd,
      tool: "run",
      intent: "fetch monet paintings from the met",
    });
    const entries = readIntentLog(cmd);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tool).toBe("run");
    expect(entries[0]!.intent).toBe("fetch monet paintings from the met");
    expect(entries[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("includes optional meta field when provided", () => {
    logIntent({
      codeModeDir: cmd,
      tool: "save",
      intent: "persist monet wiki join helper",
      meta: { name: "monet-wiki-join", size: 1234 },
    });
    const [entry] = readIntentLog(cmd);
    expect(entry!.meta).toEqual({ name: "monet-wiki-join", size: 1234 });
  });

  test("omits meta when not provided", () => {
    logIntent({ codeModeDir: cmd, tool: "search", intent: "monet paintings" });
    const [entry] = readIntentLog(cmd);
    expect(entry!.meta).toBeUndefined();
  });

  test("multiple writes append in order", () => {
    logIntent({ codeModeDir: cmd, tool: "run", intent: "first intent string here" });
    logIntent({ codeModeDir: cmd, tool: "run", intent: "second intent string here" });
    logIntent({ codeModeDir: cmd, tool: "run", intent: "third intent string here" });
    const entries = readIntentLog(cmd);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.intent)).toEqual([
      "first intent string here",
      "second intent string here",
      "third intent string here",
    ]);
  });

  test("readIntentLog returns empty list when file is missing", () => {
    expect(readIntentLog(cmd)).toEqual([]);
  });

  test("readIntentLog skips corrupt lines rather than throwing", () => {
    logIntent({ codeModeDir: cmd, tool: "run", intent: "valid entry one here now" });
    const path = join(cmd, "intent-log.jsonl");
    // Inject a bogus line in the middle.
    const current = readFileSync(path, "utf8");
    writeFileSync(path, current + "{not-valid-json\n", "utf8");
    logIntent({ codeModeDir: cmd, tool: "run", intent: "valid entry two here now" });
    const entries = readIntentLog(cmd);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.intent).toBe("valid entry one here now");
    expect(entries[1]!.intent).toBe("valid entry two here now");
  });

  test("creates .code-mode dir if missing", () => {
    expect(existsSync(cmd)).toBe(false);
    logIntent({ codeModeDir: cmd, tool: "run", intent: "fetch monet paintings from met" });
    expect(existsSync(join(cmd, "intent-log.jsonl"))).toBe(true);
  });

  test("compactIntentLog trims to maxEntries from the tail", () => {
    for (let i = 0; i < 20; i++) {
      logIntent({
        codeModeDir: cmd,
        tool: "run",
        intent: `entry number ${i} for rotation test here`,
      });
    }
    compactIntentLog(cmd, 5);
    const entries = readIntentLog(cmd);
    expect(entries).toHaveLength(5);
    expect(entries[0]!.intent).toContain("entry number 15");
    expect(entries[4]!.intent).toContain("entry number 19");
  });

  test("compactIntentLog no-ops when under maxEntries", () => {
    logIntent({ codeModeDir: cmd, tool: "run", intent: "only entry here in the log" });
    compactIntentLog(cmd, 100);
    const entries = readIntentLog(cmd);
    expect(entries).toHaveLength(1);
  });

  test("compactIntentLog on missing file is safe", () => {
    expect(() => compactIntentLog(cmd, 100)).not.toThrow();
  });
});
