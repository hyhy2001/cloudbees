/**
 * SQLite connection and database initialisation.
 * Bun:sqlite sync API — behavioural 1:1 port of legacy/cb/db/connection.py
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

// Module-level cache — mirrors _DB_PATH global in Python
let _DB_PATH: string | null = null;

/**
 * Best-effort detection of the bee project root directory.
 * Python used pyproject.toml + cb dir markers, or .venv detection.
 * TS equivalent: walk up from import.meta.dir looking for a directory
 * that contains both package.json and a `src` folder.
 */
function detectBeeRoot(): string | null {
  // 1) Explicit BEE_DIR override
  const beeDir = process.env.BEE_DIR;
  if (beeDir) {
    if (existsSync(beeDir)) return beeDir;
  }

  // 2) Walk up from this file's directory for package.json + src/
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
 *   2. <bee_root>/data/cb.db (auto-detected)
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
 * Caller is responsible for calling db.close().
 * Mirrors Python get_connection().
 */
export function getConnection(dbPath?: string): Database {
  const path = dbPath ?? getDbPath();

  // Ensure parent directory exists (needed when dbPath is caller-supplied)
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  // SQLite 3.7 compatible pragmas only — matches Python exactly
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA journal_mode = DELETE"); // NOT WAL -- 3.7 compat
  return db;
}

/**
 * Create tables from schema.sql if they don't already exist.
 * Also runs the transparent migration for user_resources.controller_name.
 * Mirrors Python init_db().
 */
export function initDb(dbPath?: string): void {
  const schemaPath = join(import.meta.dir, "schema.sql");
  const sql = readFileSync(schemaPath, "utf-8");

  const db = getConnection(dbPath);
  try {
    db.exec(sql);

    // Transparent migration: add controller_name if it doesn't exist yet
    try {
      db.run(
        "ALTER TABLE user_resources ADD COLUMN controller_name TEXT NOT NULL DEFAULT ''"
      );
    } catch {
      // Column already exists — ignore
    }
  } finally {
    db.close();
  }
}

/**
 * Override DB path — used in tests for temp or in-memory DBs.
 * Mirrors Python set_db_path().
 */
export function setDbPath(path: string): void {
  _DB_PATH = path;
}
