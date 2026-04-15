/**
 * Auto-save logic for successful inline `run` invocations.
 *
 * When the agent calls `mcp__code-mode__run` with an inline source + an
 * `intent`, we persist the script to `.code-mode/scripts/auto/<slug>.ts`
 * so it can be found later via `__search`. This turns throwaway inline
 * scripts into a searchable corpus without requiring the agent to call
 * `__save` explicitly.
 *
 * Three guard rails keep `scripts/auto/` from becoming noise:
 *
 *   1. **shouldAutoSave** — skip trivial snippets (<5 non-comment lines, or
 *      no import/export/function/class declaration). One-liners and smoke
 *      probes shouldn't land in the search index.
 *
 *   2. **Hash dedupe** — compute a content hash of the normalized source; if
 *      an existing auto-save carries the same hash (in its header comment),
 *      we return `deduped` without writing a new file. The caller can tell
 *      the agent "reused" so it learns the retrieval path.
 *
 *   3. **Slug fallback** — if `slugify(intent)` rejects the intent as too
 *      thin, `writeAutoSave` falls back to `auto-<hash8>.ts`. Callers
 *      decide whether to treat fallback as acceptable or log a warning.
 *
 * File header shape (required so `findByHash` can round-trip):
 *
 *   // auto-save
 *   // intent: <intent>
 *   // hash: <sha256 hex>
 *   // ts: <iso>
 *
 *   <source>
 *
 * Reindex: when a `db` handle is passed, we upsert into `scripts` with
 * `name = "auto/<slug>"`, `description = intent`, `tags = ["auto"]` so
 * FTS5 search picks it up immediately without waiting for a full reindex.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "better-sqlite3";
import { upsertScript } from "../db/repo.ts";
import { slugify } from "./slug.ts";

export type AutoSaveReason =
  | "saved"
  | "deduped"
  | "skipped-trivial"
  | "skipped-invalid-intent";

export interface AutoSaveResult {
  reason: AutoSaveReason;
  /** Present on `saved` and `deduped`. */
  slug?: string;
  /** Absolute path. Present on `saved` and `deduped`. */
  path?: string;
  /** Content hash used for dedupe. Always present. */
  hash: string;
  /** Details for skipped/invalid cases. */
  detail?: string;
}

export interface AutoSaveInput {
  intent: string;
  source: string;
  /** `<workspaceDir>/.code-mode` — the dir auto/ will live under. */
  codeModeDir: string;
  /** Optional DB handle for immediate FTS5 indexing. */
  db?: Database;
}

/**
 * Heuristic filter for "is this script worth saving?"
 *
 * The agent often runs tiny probes (`console.log(1+1)`) or one-liner
 * smoke tests. Saving those pollutes the search corpus with noise that
 * will never be reused. We require:
 *   - ≥5 non-comment, non-blank lines, AND
 *   - at least one structural keyword (import/export/function/class/const)
 *
 * Both conditions protect against different noise shapes: the line count
 * filters one-liners; the keyword filter rejects 5+ lines of pure
 * `console.log` statements without any reusable structure.
 */
export function shouldAutoSave(source: string): { save: boolean; reason?: string } {
  const lines = source
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("//") &&
        !l.startsWith("/*") &&
        !l.startsWith("*") &&
        !l.startsWith("*/"),
    );
  if (lines.length < 5) {
    return { save: false, reason: `only ${lines.length} non-comment line(s) (<5)` };
  }
  const hasStructure = /\b(import|export|function|class)\b/.test(source);
  if (!hasStructure) {
    return { save: false, reason: "no import/export/function/class declaration" };
  }
  return { save: true };
}

export function writeAutoSave(input: AutoSaveInput): AutoSaveResult {
  const hash = contentHash(input.source);

  const check = shouldAutoSave(input.source);
  if (!check.save) {
    return { reason: "skipped-trivial", hash, detail: check.reason };
  }

  const autoDir = join(input.codeModeDir, "scripts", "auto");
  mkdirSync(autoDir, { recursive: true });

  const existing = findByHash(autoDir, hash);
  if (existing) {
    return {
      reason: "deduped",
      hash,
      slug: basename(existing, ".ts"),
      path: existing,
    };
  }

  const slugRes = slugify(input.intent, { fallbackHash: hash });
  if (!slugRes.slug) {
    return {
      reason: "skipped-invalid-intent",
      hash,
      detail: slugRes.reason ?? "slugify returned empty",
    };
  }

  const finalSlug = nextFreeSlug(autoDir, slugRes.slug);
  const fullPath = join(autoDir, `${finalSlug}.ts`);

  const header = [
    "// auto-save",
    `// intent: ${input.intent.trim()}`,
    `// hash: ${hash}`,
    `// ts: ${new Date().toISOString()}`,
    "",
    "",
  ].join("\n");
  writeFileSync(fullPath, header + input.source, "utf8");

  if (input.db) {
    try {
      upsertScript(input.db, {
        path: fullPath,
        name: `auto/${finalSlug}`,
        description: input.intent.trim(),
        tags: ["auto"],
        exportsJson: "[]",
        signatures: input.intent.trim(),
        indexedAt: new Date().toISOString(),
      });
    } catch {
      // Indexing failures shouldn't fail the run. Reindex will catch up.
    }
  }

  return { reason: "saved", hash, slug: finalSlug, path: fullPath };
}

// ──────────────────────────────────────────────────────────────── helpers ──

function contentHash(source: string): string {
  return createHash("sha256").update(normalizeSource(source)).digest("hex");
}

function normalizeSource(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

const HASH_HEADER_RE = /^\/\/ hash: ([a-f0-9]+)\s*$/m;

function findByHash(dir: string, hash: string): string | null {
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const path = join(dir, f);
    let head: string;
    try {
      head = readFileSync(path, "utf8").slice(0, 512);
    } catch {
      continue;
    }
    const m = head.match(HASH_HEADER_RE);
    if (m && m[1] === hash) return path;
  }
  return null;
}

function nextFreeSlug(dir: string, base: string): string {
  if (!existsSync(join(dir, `${base}.ts`))) return base;
  let n = 2;
  while (existsSync(join(dir, `${base}-${n}.ts`))) n += 1;
  return `${base}-${n}`;
}
