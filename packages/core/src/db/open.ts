/**
 * Runtime-dispatched SQLite open.
 *
 * Bun can't load `better-sqlite3`'s native addon (bun issue #4290), and Node
 * has no `bun:sqlite`. So we pick the driver at open time based on runtime,
 * and rely on both drivers exposing a compatible prepared-statement surface:
 *
 *   - `better-sqlite3`: uses `$name` / `:name` / `@name` placeholders, binds
 *     from object keys **without** the prefix.
 *   - `bun:sqlite` in `strict: true` mode: same — object keys without prefix.
 *
 * That's enough to let all CRUD call sites use a single type (`Database` from
 * `better-sqlite3`) as the compile-time spec, while the runtime shape comes
 * from whichever driver the current runtime loaded. We pay for that with a
 * structural-cast at the open boundary and nowhere else.
 */

import { createRequire } from "node:module";
import type { Database } from "better-sqlite3";

const require = createRequire(import.meta.url);

export interface OpenOptions {
  readonly?: boolean;
}

function isBun(): boolean {
  return typeof (globalThis as unknown as { Bun?: unknown }).Bun !== "undefined";
}

export function openDatabase(filename: string, options?: OpenOptions): Database {
  if (isBun()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Database: BunDb } = require("bun:sqlite");
    return new BunDb(filename, {
      strict: true,
      readonly: options?.readonly ?? false,
    }) as unknown as Database;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BetterSqlite = require("better-sqlite3");
  return new BetterSqlite(filename, options);
}
