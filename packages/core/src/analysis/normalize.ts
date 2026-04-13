/**
 * Source normalizer for `save` and inline `run`.
 *
 * LLMs routinely emit TypeScript source wrapped in cosmetic scaffolding that
 * breaks `ts-morph` typecheck for non-semantic reasons. We strip three such
 * wrappers — BOM, shebang, markdown code fence — before the source reaches
 * the compiler. Everything else is preserved verbatim, including indentation
 * and top-of-file comments.
 *
 * Medium-aggressiveness by design: no prose detection, no expression wrapping.
 * Decided with Taras in plan `adaptive-conjuring-flute.md`.
 */

export interface NormalizeResult {
  source: string;
  changed: boolean;
  notes: string[];
}

const BOM = "\uFEFF";
const FENCE_RE = /^\s*```[a-zA-Z0-9_+.-]*\s*\n([\s\S]*?)(?:\n\s*```\s*)?$/;
const SHEBANG_RE = /^#![^\n]*\n?/;

export function normalizeScriptSource(raw: string): NormalizeResult {
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

  return { source, changed: notes.length > 0, notes };
}
