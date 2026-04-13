import { describe, expect, test } from "bun:test";
import { loadProject, scopedExtract } from "../../src/analysis/project.ts";
import { extractExports } from "../../src/analysis/extract.ts";

describe("memory smoke", () => {
  test("extracting over 50 synthetic files keeps heap growth bounded", () => {
    const project = loadProject("/virtual", { inMemory: true });

    // Warm up the compiler cache so we measure steady-state growth, not cold
    // start. One file plus an initial diagnostic run is enough.
    project.createSourceFile(
      "/virtual/warmup.ts",
      `export const warm = 1;`,
    );
    extractExports(project, "/virtual/warmup.ts");

    // Allocate 50 files with enough type complexity to exercise the extractor.
    const COUNT = 50;
    for (let i = 0; i < COUNT; i++) {
      project.createSourceFile(
        `/virtual/mod${i}.ts`,
        `
          /**
           * @name fn${i}
           * @description Module number ${i}.
           */
          export function fn${i}<T>(items: T[], pred: (t: T) => boolean): T[] {
            return items.filter(pred);
          }
          export interface Opts${i} { enabled: boolean; limit: number; }
          export type Result${i} = { ok: boolean; data: Opts${i} };
          export const DEFAULT_${i}: Result${i} = { ok: true, data: { enabled: true, limit: ${i} } };
        `.trim(),
      );
    }

    // Force a GC sample before taking the baseline.
    if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
      Bun.gc(true);
    }
    const baseline = process.memoryUsage().heapUsed;

    let totalExports = 0;
    for (let i = 0; i < COUNT; i++) {
      const filePath = `/virtual/mod${i}.ts`;
      scopedExtract(project, () => {
        totalExports += extractExports(project, filePath).length;
      });
    }

    if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
      Bun.gc(true);
    }
    const after = process.memoryUsage().heapUsed;
    const growthMB = (after - baseline) / (1024 * 1024);

    // Each file exports 4 things.
    expect(totalExports).toBe(COUNT * 4);
    // Heap growth threshold — 100MB is a very loose ceiling; scopedExtract
    // should keep us well under this. If this fires, the forget-nodes hook
    // almost certainly regressed.
    expect(growthMB).toBeLessThan(100);
  });
});
