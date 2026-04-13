import { describe, expect, test } from "bun:test";
import { loadProject } from "../../src/analysis/project.ts";
import {
  extractExports,
  type ExportInfo,
} from "../../src/analysis/extract.ts";

function makeProject() {
  return loadProject("/virtual", { inMemory: true });
}

describe("extractExports", () => {
  test("extracts all export kinds from a valid file", () => {
    const project = makeProject();
    project.createSourceFile(
      "/virtual/sample.ts",
      `
        export function add(a: number, b: number): number { return a + b; }
        export class Box { x = 1; }
        export interface Point { x: number; y: number; }
        export type ID = string | number;
        export const PI = 3.14;
      `.trim(),
    );

    const infos = extractExports(project, "/virtual/sample.ts");
    const byName = new Map(infos.map((i) => [i.name, i]));

    expect(byName.get("add")?.kind).toBe("function");
    expect(byName.get("Box")?.kind).toBe("class");
    expect(byName.get("Point")?.kind).toBe("interface");
    expect(byName.get("ID")?.kind).toBe("type");
    expect(byName.get("PI")?.kind).toBe("const");

    // Signatures are non-empty and include relevant shape info.
    expect(byName.get("add")?.signature).toContain("number");
    expect(byName.get("Point")?.signature).toContain("x: number");
    expect(byName.get("ID")?.signature).toContain("string");
    expect(byName.get("PI")?.signature).toContain("3.14");
  });

  test("JSDoc description and custom tags flow through", () => {
    const project = makeProject();
    project.createSourceFile(
      "/virtual/docs.ts",
      `
        /**
         * @name filter
         * @description Returns a new array filtered by predicate.
         * @tags array, utility
         */
        export function filter<T>(items: T[], predicate: (item: T) => boolean): T[] {
          return items.filter(predicate);
        }
      `.trim(),
    );

    const [info] = extractExports(project, "/virtual/docs.ts");
    expect(info).toBeDefined();
    const tagMap = new Map(
      (info!.jsdocTags ?? []).map((t) => [t.name, t.value]),
    );
    expect(tagMap.get("name")).toBe("filter");
    expect(tagMap.get("description")).toContain("filtered by predicate");
    expect(tagMap.get("tags")).toBe("array, utility");
  });

  test("JSDoc description-only (no tags)", () => {
    const project = makeProject();
    project.createSourceFile(
      "/virtual/desc.ts",
      `
        /** Simple helper. Does a thing. */
        export function helper(): void {}
      `.trim(),
    );

    const [info] = extractExports(project, "/virtual/desc.ts");
    expect(info?.jsdocDescription).toContain("Simple helper");
  });

  test("returns empty array for non-existent file", () => {
    const project = makeProject();
    expect(extractExports(project, "/virtual/missing.ts")).toEqual([]);
  });

  test("result is JSON-serializable (no circular refs, no raw nodes)", () => {
    const project = makeProject();
    project.createSourceFile(
      "/virtual/json.ts",
      `
        /** demo */
        export function f(x: number): number { return x; }
        export const g = (s: string) => s.length;
        export interface I { a: number }
        export type T = { b: string };
        export class C { d = 1; }
      `.trim(),
    );

    const infos = extractExports(project, "/virtual/json.ts");
    // If anything leaks a ts-morph node, JSON.stringify throws on the cycle.
    const json = JSON.stringify(infos);
    const parsed: ExportInfo[] = JSON.parse(json);
    expect(parsed.length).toBe(infos.length);
    for (const info of parsed) {
      expect(typeof info.name).toBe("string");
      expect(typeof info.kind).toBe("string");
      expect(typeof info.signature).toBe("string");
    }
  });
});
