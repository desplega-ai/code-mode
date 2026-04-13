/**
 * Emits the `sdks/stdlib/glob.ts` seed written into a workspace on init.
 *
 * Prefers `Bun.Glob` when running under Bun, `fs.glob` on Node ≥22, and
 * falls back to a tiny hand-rolled walker + matcher on older Node. No npm
 * deps.
 */
export function globTs(): string {
  return `/**
 * @name glob
 * @description Resolves a glob pattern to a list of file paths. Uses Bun.Glob / fs.glob when available.
 * @tags files, glob, fs, utility
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface GlobOptions {
  /** Directory to search from. Default: cwd. */
  cwd?: string;
  /** Glob patterns to exclude. */
  ignore?: string[];
  /** Return absolute paths. Default: false (paths relative to cwd). */
  absolute?: boolean;
}

/**
 * @name glob
 * @description Expand \`pattern\` under \`cwd\` to a list of matching file paths.
 * @tags files, glob, fs
 */
export async function glob(pattern: string, options: GlobOptions = {}): Promise<string[]> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const ignore = options.ignore ?? [];
  const toAbsolute = options.absolute ?? false;

  // Prefer Bun.Glob when available — it's fast and native.
  const bunGlobal = (globalThis as unknown as { Bun?: { Glob: new (p: string) => { scan: (o: { cwd: string }) => AsyncIterable<string> } } }).Bun;
  if (typeof bunGlobal !== "undefined" && bunGlobal && bunGlobal.Glob) {
    const g = new bunGlobal.Glob(pattern);
    const out: string[] = [];
    for await (const rel of g.scan({ cwd })) {
      if (matchesAny(rel, ignore)) continue;
      out.push(toAbsolute ? join(cwd, rel) : rel);
    }
    return out.sort();
  }

  // Node ≥22 has \`fs.glob\`. Dynamic import so ts-morph doesn't trip on older
  // @types/node during typecheck in the emitter project.
  try {
    const fsMod = (await import("node:fs/promises")) as unknown as {
      glob?: (p: string, o: { cwd: string }) => AsyncIterable<string>;
    };
    if (typeof fsMod.glob === "function") {
      const out: string[] = [];
      for await (const rel of fsMod.glob(pattern, { cwd })) {
        if (matchesAny(rel, ignore)) continue;
        out.push(toAbsolute ? join(cwd, rel) : rel);
      }
      return out.sort();
    }
  } catch {
    // Fall through to the manual walker.
  }

  // Manual fallback: walk the tree, match each file against a regex compiled
  // from the pattern.
  const re = compileGlob(pattern);
  const results: string[] = [];
  walk(cwd, cwd, (abs) => {
    const rel = relative(cwd, abs).split(sep).join("/");
    if (!re.test(rel)) return;
    if (matchesAny(rel, ignore)) return;
    results.push(toAbsolute ? abs : rel);
  });
  return results.sort();
}

function walk(root: string, dir: string, visit: (abs: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, abs, visit);
    } else if (entry.isFile()) {
      visit(abs);
    } else if (entry.isSymbolicLink()) {
      // Treat symlinks as files if they resolve to files; skip if broken.
      try {
        const s = statSync(abs);
        if (s.isFile()) visit(abs);
      } catch {
        // broken symlink — skip
      }
    }
  }
}

function matchesAny(path: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (compileGlob(p).test(path)) return true;
  }
  return false;
}

/**
 * Compile a minimal glob pattern into a RegExp. Supports:
 *   - \`*\`   → any chars except \`/\`
 *   - \`**\`  → any chars including \`/\`
 *   - \`?\`   → single char except \`/\`
 *   - character classes \`[abc]\`
 */
function compileGlob(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === ".") {
      re += "\\\\.";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end < 0) {
        re += "\\\\[";
      } else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else if ("()+^$|{}\\\\".includes(c!)) {
      re += "\\\\" + c;
    } else {
      re += c;
    }
    i++;
  }
  return new RegExp("^" + re + "$");
}
`;
}
