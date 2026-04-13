/**
 * Smoke tests for the new stdlib templates (fetch, grep, glob).
 *
 * These tests don't exec the emitted string via the CLI — that path is
 * covered by the manual E2E. Instead, we write each template's emitted
 * source to a tmp file and dynamically `import()` it, then call the
 * exported helpers against local fixtures.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { AddressInfo } from "node:net";

import { fetchTs } from "../../src/templates/stdlib/fetch.ts";
import { grepTs } from "../../src/templates/stdlib/grep.ts";
import { globTs } from "../../src/templates/stdlib/glob.ts";

const hasRg = (() => {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["rg"], {
    stdio: "ignore",
  });
  return probe.status === 0;
})();

function writeTemplate(dir: string, name: string, content: string): string {
  const abs = join(dir, name);
  writeFileSync(abs, content, "utf8");
  return abs;
}

describe("stdlib/fetch template", () => {
  let server: Server;
  let port: number;
  let helperPath: string;
  let tmp: string;
  let flakyHits = 0;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cm-stdlib-fetch-"));
    helperPath = writeTemplate(tmp, "fetch.ts", fetchTs());

    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ hello: "world" }));
        return;
      }
      if (url === "/text") {
        res.setHeader("content-type", "text/plain");
        res.end("plain body");
        return;
      }
      if (url === "/echo" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              received: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              contentType: req.headers["content-type"] ?? null,
              accept: req.headers["accept"] ?? null,
            }),
          );
        });
        return;
      }
      if (url === "/flaky") {
        flakyHits++;
        if (flakyHits < 3) {
          res.statusCode = 500;
          res.end("fail");
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, attempts: flakyHits }));
        return;
      }
      if (url === "/hang") {
        // Deliberately never respond — forces AbortController timeout path.
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  test("getJson returns parsed JSON and sets Accept header", async () => {
    const mod = (await import(helperPath)) as typeof import("../../src/templates/stdlib/fetch.ts") & {
      getJson: <T>(u: string, i?: unknown) => Promise<T>;
      postJson: <T>(u: string, b: unknown, i?: unknown) => Promise<T>;
      fetchText: (u: string, i?: unknown) => Promise<string>;
    };
    const data = await mod.getJson<{ hello: string }>(`http://127.0.0.1:${port}/json`);
    expect(data.hello).toBe("world");
  });

  test("fetchText returns the response body", async () => {
    const mod = (await import(helperPath)) as {
      fetchText: (u: string, i?: unknown) => Promise<string>;
    };
    const text = await mod.fetchText(`http://127.0.0.1:${port}/text`);
    expect(text).toBe("plain body");
  });

  test("postJson sends JSON body with content-type and echoes back", async () => {
    const mod = (await import(helperPath)) as {
      postJson: <T>(u: string, b: unknown, i?: unknown) => Promise<T>;
    };
    const echoed = await mod.postJson<{ received: unknown; contentType: string; accept: string }>(
      `http://127.0.0.1:${port}/echo`,
      { foo: 42 },
    );
    expect(echoed.received).toEqual({ foo: 42 });
    expect(echoed.contentType).toContain("application/json");
    expect(echoed.accept).toContain("application/json");
  });

  test("retries on 5xx until success", async () => {
    flakyHits = 0;
    const mod = (await import(helperPath)) as {
      getJson: <T>(u: string, i?: unknown) => Promise<T>;
    };
    const data = await mod.getJson<{ ok: boolean; attempts: number }>(
      `http://127.0.0.1:${port}/flaky`,
      { backoffBaseMs: 5 },
    );
    expect(data.ok).toBe(true);
    expect(data.attempts).toBe(3);
  });

  test("timeout aborts the request", async () => {
    const mod = (await import(helperPath)) as {
      fetchText: (u: string, i?: unknown) => Promise<string>;
    };
    let threw = false;
    try {
      await mod.fetchText(`http://127.0.0.1:${port}/hang`, {
        timeoutMs: 50,
        retries: 0,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("stdlib/grep template", () => {
  let tmp: string;
  let helperPath: string;
  let fixtureDir: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "cm-stdlib-grep-"));
    helperPath = writeTemplate(tmp, "grep.ts", grepTs());
    fixtureDir = join(tmp, "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, "a.txt"), "hello world\nfoo bar\nTARGET line\n", "utf8");
    writeFileSync(join(fixtureDir, "b.txt"), "another TARGET here\nno match\n", "utf8");
    writeFileSync(join(fixtureDir, "c.md"), "# markdown TARGET doc\n", "utf8");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test.skipIf(!hasRg)("grep returns structured hits across fixture files", async () => {
    const mod = (await import(helperPath)) as {
      grep: (p: string, o: unknown) => Array<{ file: string; line: number; text: string }>;
    };
    const hits = mod.grep("TARGET", { path: fixtureDir });
    expect(hits.length).toBeGreaterThanOrEqual(3);
    for (const h of hits) {
      expect(typeof h.file).toBe("string");
      expect(typeof h.line).toBe("number");
      expect(h.text).toContain("TARGET");
    }
  });

  test.skipIf(!hasRg)("grep honours glob filter", async () => {
    const mod = (await import(helperPath)) as {
      grep: (p: string, o: unknown) => Array<{ file: string; line: number; text: string }>;
    };
    const hits = mod.grep("TARGET", { path: fixtureDir, glob: "*.md" });
    expect(hits.length).toBe(1);
    expect(hits[0]!.file).toContain("c.md");
  });

  test.skipIf(!hasRg)("grep returns empty array for no matches (rg exit 1)", async () => {
    const mod = (await import(helperPath)) as {
      grep: (p: string, o: unknown) => Array<{ file: string; line: number; text: string }>;
    };
    const hits = mod.grep("NEVER_FOUND_NEEDLE_XYZ", { path: fixtureDir });
    expect(hits).toEqual([]);
  });

  if (!hasRg) {
    test("skipped: ripgrep (`rg`) is not on PATH — grep smoke tests skipped", () => {
      expect(hasRg).toBe(false);
    });
  }
});

describe("stdlib/glob template", () => {
  let tmp: string;
  let helperPath: string;
  let fixtureDir: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "cm-stdlib-glob-"));
    helperPath = writeTemplate(tmp, "glob.ts", globTs());
    fixtureDir = join(tmp, "fixtures");
    mkdirSync(join(fixtureDir, "nested"), { recursive: true });
    writeFileSync(join(fixtureDir, "a.ts"), "// a", "utf8");
    writeFileSync(join(fixtureDir, "b.ts"), "// b", "utf8");
    writeFileSync(join(fixtureDir, "readme.md"), "# r", "utf8");
    writeFileSync(join(fixtureDir, "nested", "c.ts"), "// c", "utf8");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("glob matches **/*.ts in fixture dir", async () => {
    const mod = (await import(helperPath)) as {
      glob: (p: string, o: unknown) => Promise<string[]>;
    };
    const hits = await mod.glob("**/*.ts", { cwd: fixtureDir });
    const names = hits.map((h) => h.replace(/\\/g, "/")).sort();
    expect(names).toContain("a.ts");
    expect(names).toContain("b.ts");
    expect(names).toContain("nested/c.ts");
    expect(names.some((n) => n.endsWith(".md"))).toBe(false);
  });

  test("glob absolute: true returns absolute paths", async () => {
    const mod = (await import(helperPath)) as {
      glob: (p: string, o: unknown) => Promise<string[]>;
    };
    const hits = await mod.glob("*.ts", { cwd: fixtureDir, absolute: true });
    for (const h of hits) {
      expect(h.startsWith(resolve(fixtureDir))).toBe(true);
    }
  });
});
