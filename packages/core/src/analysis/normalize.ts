/**
 * Source normalizer for `save` and inline `run`.
 *
 * LLMs routinely emit TypeScript source wrapped in cosmetic scaffolding that
 * breaks `ts-morph` typecheck for non-semantic reasons. We strip three such
 * wrappers — BOM, shebang, markdown code fence — before the source reaches
 * the compiler. Everything else is preserved verbatim, including indentation
 * and top-of-file comments.
 *
 * In addition, when `opts.codeModeDir` is provided, any `@/...` import
 * specifier (matching the tsconfig paths alias we emit in
 * `templates/tsconfig.json.ts`) is rewritten to an absolute path. This
 * matters for inline scripts that get written to a tmpdir outside the
 * workspace: Bun walks up from the entry file looking for a tsconfig and
 * doesn't find ours, so the alias silently fails to resolve. Rewriting to
 * absolute paths makes the mapping deterministic — the agent can write
 * `@/sdks/.generated/Unit_Converter` exactly as documented and the loader
 * sees `<workspaceDir>/.code-mode/sdks/.generated/Unit_Converter` at
 * import time.
 *
 * Medium-aggressiveness by design: no prose detection, no expression wrapping.
 * Decided with Taras in plan `adaptive-conjuring-flute.md`.
 */

import { join } from "node:path";

export interface NormalizeResult {
  source: string;
  changed: boolean;
  notes: string[];
}

export interface NormalizeOptions {
  /**
   * Absolute path to `<workspaceDir>/.code-mode/`. When set, `@/...`
   * import specifiers are rewritten to absolute paths under this dir.
   * Omit (or pass undefined) to keep sources literal — saved scripts
   * that already live inside the workspace don't need the rewrite.
   */
  codeModeDir?: string;
}

const BOM = "\uFEFF";
const FENCE_RE = /^\s*```[a-zA-Z0-9_+.-]*\s*\n([\s\S]*?)(?:\n\s*```\s*)?$/;
const SHEBANG_RE = /^#![^\n]*\n?/;

/**
 * Matches an import-ish context followed by a quoted `@/...` specifier.
 *
 * The prefix alternatives cover the shapes we care about:
 *   - `from "@/..."`             (static import + re-export)
 *   - `import("@/...")`          (dynamic import)
 *   - `import "@/..."`           (side-effect import)
 *
 * We deliberately do NOT rewrite arbitrary string literals that happen to
 * start with `@/`, because those aren't module specifiers. The keyword
 * context eliminates false positives in e.g. `const s = "@/not-an-import";`.
 */
const IMPORT_ALIAS_RE =
  /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(@\/[^"'\n]+)\2/g;

export interface RewriteResult {
  source: string;
  changed: boolean;
  count: number;
}

/**
 * Rewrite `@/...` import specifiers in `source` to absolute paths rooted
 * at `codeModeDir`. Exported for tests and for direct use by callers that
 * want the rewrite without the other normalization steps.
 */
export function rewriteWorkspaceAliases(
  source: string,
  codeModeDir: string,
): RewriteResult {
  let count = 0;
  const replaced = source.replace(
    IMPORT_ALIAS_RE,
    (_full, prefix: string, quote: string, alias: string) => {
      // alias looks like `@/sdks/.generated/Unit_Converter` — strip the
      // leading `@/` and join under codeModeDir. Deterministic, 1:1.
      const rest = alias.slice(2); // drop "@/"
      const abs = join(codeModeDir, rest);
      count += 1;
      return `${prefix}${quote}${abs}${quote}`;
    },
  );
  return { source: replaced, changed: count > 0, count };
}

export function normalizeScriptSource(
  raw: string,
  opts?: NormalizeOptions,
): NormalizeResult {
  const notes: string[] = [];
  let source = raw;

  if (source.startsWith(BOM)) {
    source = source.slice(BOM.length);
    notes.push("stripped UTF-8 BOM");
  }

  const fenceMatch = source.match(FENCE_RE);
  if (fenceMatch) {
    source = (fenceMatch[1] ?? "").replace(/\s+$/, "");
    notes.push("stripped markdown code fence");
  }

  if (SHEBANG_RE.test(source)) {
    source = source.replace(SHEBANG_RE, "");
    notes.push("removed shebang");
    // Shebang may have masked a BOM that now sits at position 0.
    if (source.startsWith(BOM)) {
      source = source.slice(BOM.length);
      if (!notes.includes("stripped UTF-8 BOM")) {
        notes.push("stripped UTF-8 BOM");
      }
    }
  }

  if (opts?.codeModeDir) {
    const rewritten = rewriteWorkspaceAliases(source, opts.codeModeDir);
    if (rewritten.changed) {
      source = rewritten.source;
      notes.push(
        `rewrote ${rewritten.count} \`@/...\` import${rewritten.count === 1 ? "" : "s"} to absolute paths`,
      );
    }
  }

  return { source, changed: notes.length > 0, notes };
}
