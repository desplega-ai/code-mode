import { describe, expect, test } from "bun:test";
import { loadProject } from "../../src/analysis/project.ts";
import {
  typecheckAll,
  typecheckFile,
  type Diagnostic,
} from "../../src/analysis/typecheck.ts";

function makeProject() {
  return loadProject("/virtual", { inMemory: true });
}

describe("typecheck", () => {
  test("valid file returns no diagnostics", () => {
    const project = makeProject();
    project.createSourceFile(
      "/virtual/ok.ts",
      `export function add(a: number, b: number): number { return a + b; }`,
    );
    const diags = typecheckFile(project, "/virtual/ok.ts");
    expect(diags).toEqual([]);
  });

  test("broken file returns diagnostics with expected shape", () => {
    const project = makeProject();
    project.createSourceFile(
      "/virtual/broken.ts",
      `export function bad(a: number): string { return a; }`,
    );

    const diags = typecheckFile(project, "/virtual/broken.ts");
    expect(diags.length).toBeGreaterThan(0);
    const d = diags[0]!;
    expect(d.file).toBe("/virtual/broken.ts");
    expect(typeof d.line).toBe("number");
    expect(typeof d.col).toBe("number");
    expect(d.line).toBeGreaterThan(0);
    expect(d.col).toBeGreaterThan(0);
    expect(typeof d.code).toBe("number");
    expect(typeof d.message).toBe("string");
    expect(d.severity).toBe("error");
  });

  test("diagnostics are JSON-serializable", () => {
    const project = makeProject();
    project.createSourceFile(
      "/virtual/json-diag.ts",
      `export const x: number = "not a number";`,
    );
    const diags = typecheckFile(project, "/virtual/json-diag.ts");
    const roundtripped: Diagnostic[] = JSON.parse(JSON.stringify(diags));
    expect(roundtripped.length).toBe(diags.length);
    expect(roundtripped[0]?.severity).toBe("error");
  });

  test("typecheckAll aggregates across files", () => {
    const project = makeProject();
    project.createSourceFile(
      "/virtual/a.ts",
      `export const a: number = "oops";`,
    );
    project.createSourceFile(
      "/virtual/b.ts",
      `export const b: string = 42;`,
    );
    project.createSourceFile(
      "/virtual/c.ts",
      `export const c: number = 7;`,
    );

    const map = typecheckAll(project);
    expect(map.has("/virtual/a.ts")).toBe(true);
    expect(map.has("/virtual/b.ts")).toBe(true);
    expect(map.has("/virtual/c.ts")).toBe(false); // clean file omitted
  });

  test("file not in project surfaces a diagnostic", () => {
    const project = makeProject();
    const diags = typecheckFile(project, "/virtual/missing.ts");
    expect(diags.length).toBe(1);
    expect(diags[0]?.severity).toBe("error");
    expect(diags[0]?.message).toContain("File not found");
  });
});
