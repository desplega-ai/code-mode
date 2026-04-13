-- Initial code-mode schema.
--
-- FTS5 sync strategy: each virtual table uses `content=` to mirror its source
-- table without owning the bytes twice. We keep the FTS rows in sync via
-- explicit INSERT/DELETE in triggers below. All mutations happen inside a
-- transaction in `src/db/repo.ts`, so the triggers stay consistent.

CREATE TABLE IF NOT EXISTS scripts (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT,                      -- JSON array
  exports_json TEXT,              -- serialized ExportInfo[]
  status TEXT NOT NULL DEFAULT 'ok',  -- 'ok' | 'unusable'
  status_reason TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  last_run TEXT,
  success_rate REAL,
  indexed_at TEXT NOT NULL
);

-- NOTE: scripts_fts intentionally does NOT use `content=scripts` — the FTS
-- table indexes a synthetic `signatures` column that is not present on
-- `scripts`. Storing the few indexed columns directly in FTS (external-content
-- off) is simpler and cheap at our scale.
CREATE VIRTUAL TABLE IF NOT EXISTS scripts_fts USING fts5(
  name, description, tags, signatures
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  signature TEXT NOT NULL,
  jsdoc TEXT,
  scope TEXT NOT NULL,             -- 'stdlib' | 'sdk' | 'generated' | 'script'
  sdk_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_source_path ON symbols(source_path);
CREATE INDEX IF NOT EXISTS idx_symbols_sdk_name ON symbols(sdk_name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

-- Standalone FTS (no content=) for the same reasons noted on scripts_fts:
-- simpler write path, rowids we control match `symbols.id`.
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, signature, jsdoc
);

CREATE TABLE IF NOT EXISTS sdks (
  name TEXT PRIMARY KEY,
  scope TEXT NOT NULL,             -- 'stdlib' | 'user' | 'generated'
  source_dir TEXT NOT NULL,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  last_indexed TEXT NOT NULL
);
