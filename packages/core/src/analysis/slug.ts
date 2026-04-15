/**
 * Turn an agent-supplied `intent` string into a filesystem-safe slug.
 *
 * Used by the auto-save path in `mcp/handlers/run.ts`: every successful
 * inline `run` is persisted under `.code-mode/scripts/auto/<slug>.ts`, and
 * the slug has to be kebab-case, bounded in length, and derivable from the
 * intent in a stable way so that the same intent produces the same slug
 * (modulo hash-dedupe collision suffixes, handled a layer up in auto-save).
 *
 * When the intent is too thin to yield a useful slug — fewer than `minWords`
 * words or the cleaned-up form is shorter than `minLength` — we fall back to
 * `auto-<hash.slice(0,8)>` so the save still lands somewhere retrievable.
 * Callers can decide whether to accept that fallback or reject the save.
 */

export interface SlugOptions {
  /** Minimum cleaned-slug length before we fall back to the hash. Default 12. */
  minLength?: number;
  /** Maximum slug length after truncation. Default 64. */
  maxLength?: number;
  /** Minimum whitespace-separated words in the intent. Default 4. */
  minWords?: number;
  /**
   * sha256 (or equivalent) of the script source. When the intent is invalid,
   * we fall back to `auto-<fallbackHash.slice(0,8)>`. Required for `valid=false`
   * results; if omitted, invalid intents produce `valid=false, slug=''`.
   */
  fallbackHash?: string;
}

export interface SlugResult {
  /** The derived slug, or the fallback when `valid=false`. Empty string only if both intent and fallbackHash are missing. */
  slug: string;
  /** True if the slug was derived from the intent; false if we fell back to the hash. */
  valid: boolean;
  /** Human-readable reason when `valid=false`. */
  reason?: string;
}

const DEFAULTS = {
  minLength: 12,
  maxLength: 64,
  minWords: 4,
} as const;

export function slugify(intent: string, opts: SlugOptions = {}): SlugResult {
  const minLength = opts.minLength ?? DEFAULTS.minLength;
  const maxLength = opts.maxLength ?? DEFAULTS.maxLength;
  const minWords = opts.minWords ?? DEFAULTS.minWords;

  const trimmed = (intent ?? "").trim();
  const words = trimmed.split(/\s+/).filter(Boolean);

  if (words.length < minWords) {
    return fallback(opts.fallbackHash, `intent has ${words.length} word(s), need ≥${minWords}`);
  }

  const cleaned = trimmed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")  // non-alphanumeric → space
    .replace(/\s+/g, "-")             // spaces → dashes
    .replace(/-+/g, "-")              // collapse consecutive dashes
    .replace(/^-|-$/g, "");           // trim leading/trailing

  if (cleaned.length < minLength) {
    return fallback(opts.fallbackHash, `cleaned slug has ${cleaned.length} char(s), need ≥${minLength}`);
  }

  const slug = truncateOnWordBoundary(cleaned, maxLength);
  return { slug, valid: true };
}

function fallback(hash: string | undefined, reason: string): SlugResult {
  if (!hash) return { slug: "", valid: false, reason };
  return { slug: `auto-${hash.slice(0, 8)}`, valid: false, reason };
}

function truncateOnWordBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastDash = cut.lastIndexOf("-");
  // Only cut at dash if it's not too close to the start.
  if (lastDash > max / 2) return cut.slice(0, lastDash);
  return cut.replace(/-$/, "");
}
