/**
 * `search` — unified FTS5 search over scripts + symbols.
 *
 * Merges two FTS5 indexes (`scripts_fts`, `symbols_fts`) into a single result
 * set with a simple score. Results are pointers only — no source — so callers
 * looking at full bodies need to read the file or call `query_types` for
 * detailed symbol information.
 *
 * Score:
 *   - Each hit starts with a normalized FTS score (`-bm25(...)` so larger is
 *     better; SQLite's `bm25()` returns a cost-style value where 0 is a perfect
 *     match).
 *   - Scripts get a small "usage boost" proportional to `runs` and
 *     `success_rate`, reflecting the brainstorm guidance to rank stable scripts
 *     higher.
 *
 * Status filter:
 *   - Broken scripts (`status='unusable'`) are excluded from the `script` side
 *     of the search, per plan §531 and the brainstorm "excluded from search,
 *     visible via doctor" decision.
 */

import type { Database } from "bun:sqlite";
import { toFtsMatchExpression } from "./queryTypes.ts";

export type SearchScope = "script" | "sdk" | "stdlib" | "generated";

export interface SearchOptions {
  query: string;
  /** Restrict to a single scope. If omitted, all scopes are searched. */
  scope?: SearchScope;
  /** Restrict to a single symbol kind (ignored for scripts). */
  kind?: string;
  /** Max results merged across both indexes. Default 50. */
  limit?: number;
}

export interface SearchHit {
  /** Absolute path to the source (script file or symbol's source file). */
  path: string;
  /** Symbol / script name. */
  name: string;
  /** Optional description — scripts have a description column, symbols carry jsdoc. */
  description: string | null;
  /** Scope bucket. For scripts, always "script"; for symbols, mirrors the symbol's scope. */
  scope: SearchScope;
  /** What kind of hit — "script" vs a symbol kind (function/type/etc.). */
  kind: string;
  /** Owning SDK name for symbol hits, else null. */
  sdkName: string | null;
  /** Numeric score — higher is better. */
  score: number;
}

const DEFAULT_LIMIT = 50;

export function search(db: Database, opts: SearchOptions): SearchHit[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const trimmed = opts.query.trim();
  const useFts = trimmed.length > 0;
  const ftsExpr = useFts ? toFtsMatchExpression(trimmed) : "";

  const hits: SearchHit[] = [];

  const wantScripts =
    opts.scope === undefined || opts.scope === "script";
  const wantSymbols =
    opts.scope === undefined ||
    opts.scope === "sdk" ||
    opts.scope === "stdlib" ||
    opts.scope === "generated";

  // ── scripts ────────────────────────────────────────────────────────────
  if (wantScripts) {
    const scriptHits = searchScripts(db, { ftsExpr, useFts, limit });
    hits.push(...scriptHits);
  }

  // ── symbols ────────────────────────────────────────────────────────────
  if (wantSymbols) {
    const symbolHits = searchSymbols(db, {
      ftsExpr,
      useFts,
      limit,
      scope: opts.scope,
      kind: opts.kind,
    });
    hits.push(...symbolHits);
  }

  // Merge + sort + clip.
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────── scripts ──

function searchScripts(
  db: Database,
  args: { ftsExpr: string; useFts: boolean; limit: number },
): SearchHit[] {
  if (args.useFts) {
    const sql = `
      SELECT s.path, s.name, s.description, s.runs, s.success_rate,
             bm25(scripts_fts) AS rank
      FROM scripts s
      JOIN scripts_fts f ON f.rowid = s.rowid
      WHERE scripts_fts MATCH $q AND s.status = 'ok'
      ORDER BY rank
      LIMIT $limit
    `;
    const rows = db.query(sql).all({ $q: args.ftsExpr, $limit: args.limit }) as Array<{
      path: string;
      name: string;
      description: string | null;
      runs: number;
      success_rate: number | null;
      rank: number;
    }>;
    return rows.map((r) => ({
      path: r.path,
      name: r.name,
      description: r.description,
      scope: "script" as const,
      kind: "script",
      sdkName: null,
      score: scriptScore(r.rank, r.runs, r.success_rate),
    }));
  }
  // No query → just list status=ok scripts by recency (use runs + success_rate).
  const sql = `
    SELECT path, name, description, runs, success_rate
    FROM scripts WHERE status = 'ok'
    ORDER BY runs DESC, name ASC
    LIMIT $limit
  `;
  const rows = db.query(sql).all({ $limit: args.limit }) as Array<{
    path: string;
    name: string;
    description: string | null;
    runs: number;
    success_rate: number | null;
  }>;
  return rows.map((r) => ({
    path: r.path,
    name: r.name,
    description: r.description,
    scope: "script" as const,
    kind: "script",
    sdkName: null,
    score: scriptScore(0, r.runs, r.success_rate),
  }));
}

// ─────────────────────────────────────────────────────────────── symbols ──

function searchSymbols(
  db: Database,
  args: {
    ftsExpr: string;
    useFts: boolean;
    limit: number;
    scope?: SearchScope;
    kind?: string;
  },
): SearchHit[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { $limit: args.limit };

  // Map search scope → symbol.scope. "sdk" encompasses user SDKs only.
  if (args.scope === "stdlib") {
    where.push(`s.scope = 'stdlib'`);
  } else if (args.scope === "generated") {
    where.push(`s.scope = 'generated'`);
  } else if (args.scope === "sdk") {
    where.push(`s.scope = 'sdk'`);
  }
  if (args.kind) {
    where.push(`s.kind = $kind`);
    params.$kind = args.kind;
  }
  const whereExtra = where.length > 0 ? ` AND ${where.join(" AND ")}` : "";

  if (args.useFts) {
    params.$q = args.ftsExpr;
    const sql = `
      SELECT s.source_path, s.name, s.kind, s.scope, s.sdk_name, s.jsdoc,
             bm25(symbols_fts) AS rank
      FROM symbols s
      JOIN symbols_fts f ON f.rowid = s.id
      WHERE symbols_fts MATCH $q${whereExtra}
      ORDER BY rank
      LIMIT $limit
    `;
    const rows = db.query(sql).all(params as never) as Array<{
      source_path: string;
      name: string;
      kind: string;
      scope: SearchScope;
      sdk_name: string | null;
      jsdoc: string | null;
      rank: number;
    }>;
    return rows.map((r) => ({
      path: r.source_path,
      name: r.name,
      description: r.jsdoc,
      scope: r.scope,
      kind: r.kind,
      sdkName: r.sdk_name,
      score: -r.rank,
    }));
  }

  const whereClause =
    where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT source_path, name, kind, scope, sdk_name, jsdoc
    FROM symbols s ${whereClause}
    ORDER BY name LIMIT $limit
  `;
  const rows = db.query(sql).all(params as never) as Array<{
    source_path: string;
    name: string;
    kind: string;
    scope: SearchScope;
    sdk_name: string | null;
    jsdoc: string | null;
  }>;
  return rows.map((r) => ({
    path: r.source_path,
    name: r.name,
    description: r.jsdoc,
    scope: r.scope,
    kind: r.kind,
    sdkName: r.sdk_name,
    score: 0,
  }));
}

/**
 * A script's final score = base FTS score + usage boost.
 *
 * `rank` from SQLite's `bm25()` is cost-style (smaller = better), so we negate
 * to make "larger = better". Usage boost: `log(runs + 1) * success_rate`, so a
 * script with many successful runs ranks above one that's never run. The
 * coefficient (0.2) keeps the boost from dominating textual relevance.
 */
function scriptScore(rank: number, runs: number, successRate: number | null): number {
  const textScore = -rank;
  const usage = Math.log(runs + 1) * (successRate ?? 0);
  return textScore + 0.2 * usage;
}
