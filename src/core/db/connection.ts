/**
 * SQLite connection and database initialisation.
 * Bun:sqlite sync API — behavioural 1:1 port of legacy/cb/db/connection.py
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
// Embed schema.sql into the bundle/binary at build time. Reading it at
// runtime via import.meta.dir breaks in the compiled binary, where the path
// resolves into Bun's virtual "/$bunfs" filesystem (file not on disk).
import schemaSql from "./schema.sql" with { type: "text" };

// Module-level cache — mirrors _DB_PATH global in Python
let _DB_PATH: string | null = null;

// ── Connection pool ────────────────────────────────────────────────────────
// Re-opening a Database on every cache read/write (open, pragma, query, close)
// causes significant thrashing: sqlite3_open is ~50 µs, and the TUI polls
// every few seconds. Instead, keep one persistent connection per dbPath so
// subsequent calls share the already-open handle.
//
// All callers follow the pattern `try { ... } finally { db.close() }`.
// To preserve that pattern while preventing the underlying connection from
// actually closing, getConnection() returns a lightweight Proxy that silences
// the close() call for pooled connections. In-memory DBs (used by tests) are
// never pooled and close normally.
//
// Bun:sqlite connections are NOT thread-safe, but Bun's JS runtime is single-
// threaded, so a module-level singleton is safe here.
const _connectionPool = new Map<string, Database>();

/** Return or create the shared persistent connection for this path. */
function getPooled(path: string): Database {
  const existing = _connectionPool.get(path);
  if (existing) return existing;

  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ":memory:") {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL"); // WAL-safe; faster than FULL
  }
  db.run("PRAGMA foreign_keys = ON");
  _connectionPool.set(path, db);
  return db;
}

/**
 * Wrap a pooled Database so that calling close() on the wrapper is a no-op.
 * All other operations are forwarded to the underlying connection.
 * This allows callers to keep their try/finally { db.close() } pattern
 * without accidentally closing the shared connection.
 */
function makePooledProxy(db: Database): Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "close") return () => { /* no-op for pooled connections */ };
      const val = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof val === "function" ? (val as (...args: unknown[]) => unknown).bind(target) : val;
    },
  });
}

/**
 * True when running inside a `bun build --compile` standalone binary.
 * In that case the bundled source lives in Bun's virtual filesystem, so
 * import.meta.dir is rooted at "/$bunfs" rather than a real on-disk path.
 */
function isCompiledBinary(): boolean {
  return import.meta.dir.startsWith("/$bunfs");
}

/**
 * Best-effort detection of the bee root directory — the directory whose
 * `data/` subfolder holds cb.db.
 *
 * - Standalone binary: the binary is self-contained, so the root is the
 *   directory the binary itself lives in (process.execPath). DB sits next
 *   to the binary: <bin dir>/data/cb.db. import.meta.dir is useless here
 *   (it points into Bun's virtual "/$bunfs" filesystem).
 * - From source (`bun run src/main.ts`): walk up from this file's directory
 *   for a folder containing both package.json and a `src/` folder.
 */
function detectBeeRoot(): string | null {
  // 1) Explicit BEE_DIR override
  const beeDir = process.env.BEE_DIR;
  if (beeDir) {
    if (existsSync(beeDir)) return beeDir;
  }

  // 2) Standalone binary → directory containing the binary
  if (isCompiledBinary()) {
    return dirname(process.execPath);
  }

  // 3) Running from source: walk up for package.json + src/
  try {
    const parts = import.meta.dir.split("/");
    for (let i = parts.length; i > 0; i--) {
      const candidate = parts.slice(0, i).join("/") || "/";
      if (
        existsSync(join(candidate, "package.json")) &&
        existsSync(join(candidate, "src"))
      ) {
        return candidate;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Return the database file path, respecting CB_DB_PATH env override.
 * Priority:
 *   1. CB_DB_PATH environment variable
 *   2. <bee_root>/data/cb.db, where bee_root is:
 *        - the directory containing the binary (standalone build), or
 *        - the auto-detected project root (running from source).
 *
 * Result is cached after first call (mirrors Python _DB_PATH global).
 */
export function getDbPath(): string {
  if (_DB_PATH !== null) return _DB_PATH;

  const env = process.env.CB_DB_PATH;
  if (env) {
    _DB_PATH = env;
  } else {
    const beeRoot = detectBeeRoot();
    if (!beeRoot) {
      throw new Error(
        "Cannot determine bee database location. Set BEE_DIR or CB_DB_PATH explicitly."
      );
    }
    const dataDir = join(beeRoot, "data");
    mkdirSync(dataDir, { recursive: true });
    _DB_PATH = join(dataDir, "cb.db");
  }

  return _DB_PATH;
}

/**
 * Open a database connection with sensible defaults.
 * Callers MUST call db.close() when done — for pooled (on-disk) connections
 * this is a no-op via a Proxy wrapper, preserving the try/finally pattern
 * without actually closing the shared handle. In-memory DBs close normally.
 * Mirrors Python get_connection().
 */
export function getConnection(dbPath?: string): Database {
  const path = dbPath ?? getDbPath();

  // In-memory DBs used by tests are never pooled — each caller gets its own
  // independent connection that closes for real.
  if (path === ":memory:") {
    mkdirSync(dirname(path === ":memory:" ? "/tmp" : path), { recursive: true });
    const db = new Database(path);
    db.run("PRAGMA foreign_keys = ON");
    return db;
  }

  return makePooledProxy(getPooled(path));
}

/**
 * Create tables from schema.sql if they don't already exist.
 * Also runs the transparent migration for user_resources.controller_name.
 * Mirrors Python init_db().
 */
export function initDb(dbPath?: string): void {
  const db = getConnection(dbPath);
  try {
    // db.exec() is deprecated in newer Bun versions — use db.run() per statement.
    for (const stmt of schemaSql.split(";").map((s) => s.trim()).filter(Boolean)) {
      db.run(stmt);
    }

    // Transparent migration: add controller_name if it doesn't exist yet
    try {
      db.run(
        "ALTER TABLE user_resources ADD COLUMN controller_name TEXT NOT NULL DEFAULT ''"
      );
    } catch {
      // Column already exists — ignore
    }
  } finally {
    db.close(); // no-op for pooled connections via the Proxy
  }
}

/**
 * Override DB path — used in tests for temp or in-memory DBs.
 * Closes and removes any pooled connection for the old path so the next
 * getConnection() re-opens cleanly against the new location.
 * Mirrors Python set_db_path().
 */
export function setDbPath(path: string): void {
  // Close and evict the pooled connection for the old default path, if any.
  if (_DB_PATH !== null) {
    const old = _connectionPool.get(_DB_PATH);
    if (old) {
      try { old.close(); } catch { /* ignore */ }
      _connectionPool.delete(_DB_PATH);
    }
  }
  _DB_PATH = path;
}
