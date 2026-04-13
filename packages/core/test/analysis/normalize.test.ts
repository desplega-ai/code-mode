import { describe, expect, test } from "bun:test";
import { normalizeScriptSource } from "../../src/analysis/normalize.ts";

describe("normalizeScriptSource", () => {
  test("plain code round-trips unchanged", () => {
    const input = 'export default async function main() {\n  return 42;\n}\n';
    const r = normalizeScriptSource(input);
    expect(r.source).toBe(input);
    expect(r.changed).toBe(false);
    expect(r.notes).toEqual([]);
  });

  test("strips ```ts fence", () => {
    const input = '```ts\nconst x = 1;\n```';
    const r = normalizeScriptSource(input);
    expect(r.source).toBe("const x = 1;");
    expect(r.changed).toBe(true);
    expect(r.notes).toContain("stripped markdown code fence");
  });

  test("strips ```typescript fence", () => {
    const r = normalizeScriptSource('```typescript\nconst x = 1;\n```');
    expect(r.source).toBe("const x = 1;");
  });

  test("strips bare ``` fence (no language tag)", () => {
    const r = normalizeScriptSource('```\nconst x = 1;\n```');
    expect(r.source).toBe("const x = 1;");
  });

  test("strips ```js fence", () => {
    const r = normalizeScriptSource('```js\nconst x = 1;\n```');
    expect(r.source).toBe("const x = 1;");
  });

  test("handles missing closing fence", () => {
    const r = normalizeScriptSource('```ts\nconst x = 1;\n');
    expect(r.source).toBe("const x = 1;");
    expect(r.changed).toBe(true);
  });

  test("strips shebang", () => {
    const input = "#!/usr/bin/env bun\nconst x = 1;\n";
    const r = normalizeScriptSource(input);
    expect(r.source).toBe("const x = 1;\n");
    expect(r.notes).toContain("removed shebang");
  });

  test("strips BOM", () => {
    const r = normalizeScriptSource("\uFEFFconst x = 1;\n");
    expect(r.source).toBe("const x = 1;\n");
    expect(r.notes).toContain("stripped UTF-8 BOM");
  });

  test("strips BOM that appears after shebang", () => {
    const input = "#!/usr/bin/env bun\n\uFEFFconst x = 1;\n";
    const r = normalizeScriptSource(input);
    expect(r.source).toBe("const x = 1;\n");
    expect(r.notes).toContain("removed shebang");
    expect(r.notes).toContain("stripped UTF-8 BOM");
  });

  test("strips BOM + shebang + fence combined", () => {
    const input = "\uFEFF```ts\n#!/usr/bin/env bun\nconst x = 1;\n```";
    const r = normalizeScriptSource(input);
    expect(r.source).toBe("const x = 1;");
    expect(r.notes).toEqual([
      "stripped UTF-8 BOM",
      "stripped markdown code fence",
      "removed shebang",
    ]);
  });

  test("empty string", () => {
    const r = normalizeScriptSource("");
    expect(r.source).toBe("");
    expect(r.changed).toBe(false);
  });

  test("whitespace-only", () => {
    const r = normalizeScriptSource("   \n\n  ");
    expect(r.source).toBe("   \n\n  ");
    expect(r.changed).toBe(false);
  });

  test("preserves indentation inside fence", () => {
    const input = "```ts\nif (a) {\n  doThing();\n}\n```";
    const r = normalizeScriptSource(input);
    expect(r.source).toBe("if (a) {\n  doThing();\n}");
  });

  test("does not strip fenced content mid-file", () => {
    const input = 'const x = "```ts";\nconst y = 2;\n';
    const r = normalizeScriptSource(input);
    expect(r.source).toBe(input);
    expect(r.changed).toBe(false);
  });
});
