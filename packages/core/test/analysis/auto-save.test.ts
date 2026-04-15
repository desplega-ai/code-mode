import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldAutoSave,
  writeAutoSave,
} from "../../src/analysis/auto-save.ts";

const SUBSTANTIAL = [
  'import { getJson } from "@/sdks/stdlib/fetch";',
  "",
  "export default async function main() {",
  '  const data = await getJson("https://api.example.com/v1/things");',
  "  return data;",
  "}",
].join("\n");

const TRIVIAL_SHORT = 'console.log("hello");\n';

const TRIVIAL_NO_STRUCTURE = [
  'console.log("line 1");',
  'console.log("line 2");',
  'console.log("line 3");',
  'console.log("line 4");',
  'console.log("line 5");',
  'console.log("line 6");',
].join("\n");

describe("shouldAutoSave", () => {
  test("accepts substantial script with imports", () => {
    const r = shouldAutoSave(SUBSTANTIAL);
    expect(r.save).toBe(true);
  });

  test("rejects script with <5 non-comment lines", () => {
    const r = shouldAutoSave(TRIVIAL_SHORT);
    expect(r.save).toBe(false);
    expect(r.reason).toContain("non-comment");
  });

  test("rejects long script with no structural keywords", () => {
    const r = shouldAutoSave(TRIVIAL_NO_STRUCTURE);
    expect(r.save).toBe(false);
    expect(r.reason).toContain("declaration");
  });

  test("ignores comment-only lines when counting", () => {
    const s = [
      "// comment",
      "// another comment",
      "// yet another",
      "// and another",
      "// five comments",
      'console.log("real line");',
    ].join("\n");
    expect(shouldAutoSave(s).save).toBe(false); // only 1 real line + no structure
  });

  test("accepts script with function declaration and enough lines", () => {
    const s = [
      "function compute(x: number) {",
      "  const doubled = x * 2;",
      "  const tripled = x * 3;",
      "  const combined = doubled + tripled;",
      "  return combined;",
      "}",
    ].join("\n");
    expect(shouldAutoSave(s).save).toBe(true);
  });
});

describe("writeAutoSave", () => {
  let tmp: string;
  let cmd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "code-mode-autosave-test-"));
    cmd = join(tmp, ".code-mode");
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("writes a new script with header on first save", () => {
    const r = writeAutoSave({
      intent: "fetch all Monet paintings from the Met",
      source: SUBSTANTIAL,
      codeModeDir: cmd,
    });
    expect(r.reason).toBe("saved");
    expect(r.slug).toBe("fetch-all-monet-paintings-from-the-met");
    expect(r.path).toBeDefined();
    const content = readFileSync(r.path!, "utf8");
    expect(content).toContain("// auto-save");
    expect(content).toContain("// intent: fetch all Monet paintings from the Met");
    expect(content).toContain(`// hash: ${r.hash}`);
    expect(content).toContain(SUBSTANTIAL);
  });

  test("dedupes by content hash on second save with same body", () => {
    const first = writeAutoSave({
      intent: "fetch all Monet paintings from the Met",
      source: SUBSTANTIAL,
      codeModeDir: cmd,
    });
    expect(first.reason).toBe("saved");

    const second = writeAutoSave({
      intent: "totally different intent words here",
      source: SUBSTANTIAL, // same body
      codeModeDir: cmd,
    });
    expect(second.reason).toBe("deduped");
    expect(second.hash).toBe(first.hash);
    expect(second.path).toBe(first.path);
    expect(second.slug).toBe(first.slug);
  });

  test("source normalization: CRLF + trailing whitespace still dedupes", () => {
    const first = writeAutoSave({
      intent: "fetch all Monet paintings from the Met",
      source: SUBSTANTIAL,
      codeModeDir: cmd,
    });
    const dirty = SUBSTANTIAL.replace(/\n/g, "\r\n").replace(/;/g, "; ");
    const second = writeAutoSave({
      intent: "fetch all Monet paintings from the Met",
      source: dirty,
      codeModeDir: cmd,
    });
    expect(second.reason).toBe("deduped");
    expect(second.hash).toBe(first.hash);
  });

  test("collision on different body + same slug suffixes with -2", () => {
    const first = writeAutoSave({
      intent: "fetch all Monet paintings from the Met",
      source: SUBSTANTIAL,
      codeModeDir: cmd,
    });
    expect(first.slug).toBe("fetch-all-monet-paintings-from-the-met");

    const altered = SUBSTANTIAL + "\n// comment to change hash\n";
    const second = writeAutoSave({
      intent: "fetch all Monet paintings from the Met",
      source: altered,
      codeModeDir: cmd,
    });
    expect(second.reason).toBe("saved");
    expect(second.slug).toBe("fetch-all-monet-paintings-from-the-met-2");
    expect(second.hash).not.toBe(first.hash);
  });

  test("skipped-trivial for short script", () => {
    const r = writeAutoSave({
      intent: "this is a substantial intent with many words",
      source: TRIVIAL_SHORT,
      codeModeDir: cmd,
    });
    expect(r.reason).toBe("skipped-trivial");
    expect(r.path).toBeUndefined();
    expect(r.hash).toBeDefined();
  });

  test("falls back to auto-<hash> when intent is too thin", () => {
    const r = writeAutoSave({
      intent: "do stuff",
      source: SUBSTANTIAL,
      codeModeDir: cmd,
    });
    expect(r.reason).toBe("saved");
    expect(r.slug).toMatch(/^auto-[a-f0-9]{8}$/);
  });

  test("fallback slug collision on second call with same body still dedupes", () => {
    const a = writeAutoSave({
      intent: "do stuff",
      source: SUBSTANTIAL,
      codeModeDir: cmd,
    });
    const b = writeAutoSave({
      intent: "other short",
      source: SUBSTANTIAL,
      codeModeDir: cmd,
    });
    // Same body → dedupe path wins before slug fallback collision matters.
    expect(b.reason).toBe("deduped");
    expect(b.path).toBe(a.path);
  });

  test("writes under .code-mode/scripts/auto/ subdir", () => {
    const r = writeAutoSave({
      intent: "fetch all Monet paintings from the Met",
      source: SUBSTANTIAL,
      codeModeDir: cmd,
    });
    expect(r.path).toContain(`${cmd}/scripts/auto/`);
  });

  test("header + source are separated by a blank line", () => {
    const r = writeAutoSave({
      intent: "fetch all Monet paintings from the Met",
      source: SUBSTANTIAL,
      codeModeDir: cmd,
    });
    const content = readFileSync(r.path!, "utf8");
    // Last header line is `// ts: ...`; then a blank line; then source.
    expect(content).toMatch(/\/\/ ts: [^\n]+\n\nimport/);
  });

  test("prior unrelated auto-save file does not interfere with hash scan", () => {
    writeFileSync(
      join(tmp, "ignore.txt"),
      "not a ts file, should be ignored",
      "utf8",
    );
    const r = writeAutoSave({
      intent: "fetch all Monet paintings from the Met",
      source: SUBSTANTIAL,
      codeModeDir: cmd,
    });
    expect(r.reason).toBe("saved");
  });
});
