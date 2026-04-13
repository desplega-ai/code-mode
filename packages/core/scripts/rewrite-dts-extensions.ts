/**
 * Post-process `dist/types/**.d.ts` to rewrite `.ts` import extensions to `.js`.
 *
 * `tsc` with `rewriteRelativeImportExtensions: true` rewrites extensions in
 * emitted `.js` files but leaves declaration files alone — consumers without
 * `allowImportingTsExtensions` would hit `TS2691: An import path cannot end with
 * a '.ts' extension`. This script fixes that by rewriting the declarations.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? "dist/types";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
let rewritten = 0;
for (const file of files) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(/(from\s+["'])(\.[^"']+)\.ts(["'])/g, "$1$2.js$3");
  if (before !== after) {
    writeFileSync(file, after, "utf8");
    rewritten++;
  }
}
process.stdout.write(`rewrote ${rewritten}/${files.length} .d.ts file(s) in ${ROOT}\n`);
