/**
 * `query_types` — FTS5-backed search over the `symbols` table.
 *
 * Strategy:
 *   - Tokenize the incoming pattern into prefix-match FTS5 terms (each term
 *     becomes `<term>*`).
 *   - Optional `sdk` / `kind` filters become SQL predicates applied after the
 *     MATCH join.
 *   - If the pattern is empty we fall back to a pure filter query (lists
 *     everything matching sdk/kind).
 */

import type { Database } from "bun:sqlite";
import type { SymbolKind, SymbolRow } from "../db/schema.ts";

export interface QueryTypesOptions {
  pattern: string;
  sdk?: string;
  kind?: SymbolKind | string;
  limit?: number;
}

export interface SymbolMatch {
  id: number;
  name: string;
  kind: string;
  signature: string;
  jsdoc: string | null;
  scope: string;
  sdkName: string | null;
  sourcePath: string;
}

const DEFAULT_LIMIT = 50;

export function queryTypes(
  db: Database,
  opts: QueryTypesOptions,
): SymbolMatch[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const whereClauses: string[] = [];
  const params: Record<string, unknown> = {};

  const trimmed = opts.pattern.trim();
  const useFts = trimmed.length > 0;

  if (opts.sdk) {
    whereClauses.push(`s.sdk_name = $sdk`);
    params.$sdk = opts.sdk;
  }
  if (opts.kind) {
    whereClauses.push(`s.kind = $kind`);
    params.$kind = opts.kind;
  }

  let sql: string;
  if (useFts) {
    const ftsExpr = toFtsMatchExpression(trimmed);
    params.$q = ftsExpr;
    const extra = whereClauses.length > 0 ? ` AND ${whereClauses.join(" AND ")}` : "";
    sql = `
      SELECT s.*
      FROM symbols s
      JOIN symbols_fts f ON f.rowid = s.id
      WHERE symbols_fts MATCH $q${extra}
      ORDER BY bm25(symbols_fts)
      LIMIT $limit
    `;
  } else {
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    sql = `SELECT s.* FROM symbols s ${where} ORDER BY s.name LIMIT $limit`;
  }
  params.$limit = limit;

  // bun:sqlite's `.all(...)` is typed to accept a tuple of primitives or a
  // single object of bindings. Casting here because the object form is the
  // correct runtime shape but TypeScript can't prove the keys match.
  const rows = db.query(sql).all(params as never) as SymbolRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    signature: r.signature,
    jsdoc: r.jsdoc,
    scope: r.scope,
    sdkName: r.sdk_name,
    sourcePath: r.source_path,
  }));
}

/**
 * Convert a user-facing pattern into an FTS5 MATCH expression.
 *
 * Rules:
 *   - Strip FTS5 metacharacters we don't want to support directly.
 *   - Split on whitespace; each non-empty term becomes `<term>*` (prefix).
 *   - Multiple terms are AND-combined (space separated).
 *
 * This keeps `code-mode query-types filter` equivalent to `filter*`, matching
 * `filter`, `filterMap`, `filtering`, etc.
 */
export function toFtsMatchExpression(raw: string): string {
  const cleaned = raw
    .replace(/[\"():^*]/g, " ")
    .trim();
  if (cleaned === "") return "*";
  const terms = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter((t) => t.length > 0)
    .map((t) => `${t}*`);
  if (terms.length === 0) return "*";
  return terms.join(" ");
}
