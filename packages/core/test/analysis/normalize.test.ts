import { describe, expect, test } from "bun:test";
import {
  normalizeScriptSource,
  rewriteWorkspaceAliases,
} from "../../src/analysis/normalize.ts";

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

describe("rewriteWorkspaceAliases", () => {
  const CMD = "/abs/workspace/.code-mode";

  test("rewrites static `from` specifier (double quotes)", () => {
    const input = 'import { foo } from "@/sdks/.generated/Unit_Converter";';
    const r = rewriteWorkspaceAliases(input, CMD);
    expect(r.source).toBe(
      `import { foo } from "${CMD}/sdks/.generated/Unit_Converter";`,
    );
    expect(r.changed).toBe(true);
    expect(r.count).toBe(1);
  });

  test("rewrites static `from` specifier (single quotes)", () => {
    const input = "import { foo } from '@/sdks/.generated/Math_MCP';";
    const r = rewriteWorkspaceAliases(input, CMD);
    expect(r.source).toBe(
      `import { foo } from '${CMD}/sdks/.generated/Math_MCP';`,
    );
    expect(r.count).toBe(1);
  });

  test("rewrites dynamic import()", () => {
    const input = 'const m = await import("@/sdks/stdlib/fetch");';
    const r = rewriteWorkspaceAliases(input, CMD);
    expect(r.source).toBe(
      `const m = await import("${CMD}/sdks/stdlib/fetch");`,
    );
    expect(r.count).toBe(1);
  });

  test("rewrites side-effect import", () => {
    const input = 'import "@/sdks/stdlib/setup";';
    const r = rewriteWorkspaceAliases(input, CMD);
    expect(r.source).toBe(`import "${CMD}/sdks/stdlib/setup";`);
    expect(r.count).toBe(1);
  });

  test("rewrites re-export `from`", () => {
    const input = 'export { foo } from "@/sdks/.generated/Wikipedia";';
    const r = rewriteWorkspaceAliases(input, CMD);
    expect(r.source).toBe(
      `export { foo } from "${CMD}/sdks/.generated/Wikipedia";`,
    );
    expect(r.count).toBe(1);
  });

  test("rewrites multiple imports in one file", () => {
    const input = [
      'import { convertTemperature } from "@/sdks/.generated/Unit_Converter";',
      'import { sum, mean } from "@/sdks/.generated/Math_MCP";',
      'import { getJson } from "@/sdks/stdlib/fetch";',
      "",
      "export default async function main() { return 0; }",
    ].join("\n");
    const r = rewriteWorkspaceAliases(input, CMD);
    expect(r.count).toBe(3);
    expect(r.source).toContain(`"${CMD}/sdks/.generated/Unit_Converter"`);
    expect(r.source).toContain(`"${CMD}/sdks/.generated/Math_MCP"`);
    expect(r.source).toContain(`"${CMD}/sdks/stdlib/fetch"`);
  });

  test("preserves non-import strings that happen to start with @/", () => {
    const input =
      'const email = "someone@/gmail.com";\nconst note = "see @/sdks/.generated/Foo";';
    const r = rewriteWorkspaceAliases(input, CMD);
    expect(r.changed).toBe(false);
    expect(r.source).toBe(input);
  });

  test("handles server names with dashes and underscores", () => {
    const input =
      'import { a } from "@/sdks/.generated/my-server";\nimport { b } from "@/sdks/.generated/another_one";';
    const r = rewriteWorkspaceAliases(input, CMD);
    expect(r.count).toBe(2);
    expect(r.source).toContain(`"${CMD}/sdks/.generated/my-server"`);
    expect(r.source).toContain(`"${CMD}/sdks/.generated/another_one"`);
  });

  test("leaves non-alias imports untouched", () => {
    const input =
      'import { readFileSync } from "node:fs";\nimport express from "express";';
    const r = rewriteWorkspaceAliases(input, CMD);
    expect(r.changed).toBe(false);
    expect(r.source).toBe(input);
  });

  test("no-op when source has no imports at all", () => {
    const input = "const x = 42;\nexport default async () => x;";
    const r = rewriteWorkspaceAliases(input, CMD);
    expect(r.changed).toBe(false);
    expect(r.count).toBe(0);
  });
});

describe("normalizeScriptSource with codeModeDir", () => {
  const CMD = "/abs/workspace/.code-mode";

  test("applies rewrite when codeModeDir is provided", () => {
    const input =
      'import { convertTemperature } from "@/sdks/.generated/Unit_Converter";';
    const r = normalizeScriptSource(input, { codeModeDir: CMD });
    expect(r.source).toBe(
      `import { convertTemperature } from "${CMD}/sdks/.generated/Unit_Converter";`,
    );
    expect(r.changed).toBe(true);
    expect(r.notes.some((n) => n.includes("import"))).toBe(true);
  });

  test("no rewrite when codeModeDir is omitted (backwards-compatible)", () => {
    const input =
      'import { convertTemperature } from "@/sdks/.generated/Unit_Converter";';
    const r = normalizeScriptSource(input);
    expect(r.source).toBe(input);
    expect(r.changed).toBe(false);
  });

  test("composes with fence stripping", () => {
    const input =
      '```ts\nimport { foo } from "@/sdks/.generated/Bar";\nconst x = 1;\n```';
    const r = normalizeScriptSource(input, { codeModeDir: CMD });
    expect(r.source).toBe(
      `import { foo } from "${CMD}/sdks/.generated/Bar";\nconst x = 1;`,
    );
    expect(r.notes).toContain("stripped markdown code fence");
    expect(r.notes.some((n) => n.includes("import"))).toBe(true);
  });
});
