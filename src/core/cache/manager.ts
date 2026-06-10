/**
 * SQLite-backed TTL cache manager for API responses.
 * 1:1 port of legacy/cb/cache/manager.py
 */

import { getConnection } from "../db/connection";
import { getTtl } from "./policy";

/** Row shape returned by SELECT on the cache table */
interface CacheRow {
  value: string;
  expires_at: number;
}

interface ExpiresRow {
  expires_at: number;
}

/**
 * Return cached value for key if not expired, else null.
 * Purges the expired entry on miss.
 */
export function getCached(key: string, dbPath?: string): unknown | null {
  const db = getConnection(dbPath);
  try {
    const now = Math.floor(Date.now() / 1000);
    const row = db
      .query<CacheRow, [string]>(
        "SELECT value, expires_at FROM cache WHERE key = ?"
      )
      .get(key);

    if (row === null) return null;

    if (row.expires_at <= now) {
      db.run("DELETE FROM cache WHERE key = ?", [key]);
      return null;
    }

    return JSON.parse(row.value) as unknown;
  } finally {
    db.close();
  }
}

/**
 * Store a value in the cache with an expiry time.
 * ttl defaults to getTtl(key); expires_at = now + ttl.
 */
export function setCache(
  key: string,
  value: unknown,
  ttl?: number,
  dbPath?: string
): void {
  const resolvedTtl = ttl ?? getTtl(key);
  const expiresAt = Math.floor(Date.now() / 1000) + resolvedTtl;
  const serialised = JSON.stringify(value);

  const db = getConnection(dbPath);
  try {
    db.run(
      "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
      [key, serialised, expiresAt]
    );
  } finally {
    db.close();
  }
}

/**
 * Delete a specific cached entry.
 */
export function invalidate(key: string, dbPath?: string): void {
  const db = getConnection(dbPath);
  try {
    db.run("DELETE FROM cache WHERE key = ?", [key]);
  } finally {
    db.close();
  }
}

/**
 * Delete all cached entries whose key starts with prefix.
 * Escapes LIKE special chars (\, %, _) exactly as the Python does.
 */
export function invalidatePrefix(prefix: string, dbPath?: string): void {
  const safePrefix = prefix
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");

  const db = getConnection(dbPath);
  try {
    db.run("DELETE FROM cache WHERE key LIKE ? ESCAPE '\\'", [
      `${safePrefix}%`,
    ]);
  } finally {
    db.close();
  }
}

/**
 * Invalidate cache for a specific resource type.
 * Mirrors Python invalidate_resource_cache exactly.
 */
export function invalidateResourceCache(
  resourceType: string,
  dbPath?: string
): void {
  if (resourceType === "job") {
    invalidatePrefix("jobs.", dbPath);
  } else if (resourceType === "credential") {
    invalidatePrefix("credentials.", dbPath);
  } else if (resourceType === "node") {
    invalidatePrefix("nodes.", dbPath);
  } else if (resourceType === "all") {
    invalidatePrefix("jobs.", dbPath);
    invalidatePrefix("credentials.", dbPath);
    invalidatePrefix("nodes.", dbPath);
  }
}

/**
 * Delete all expired cache entries. Returns count of deleted rows.
 */
export function purgeExpired(dbPath?: string): number {
  const db = getConnection(dbPath);
  try {
    const now = Math.floor(Date.now() / 1000);
    const result = db.run("DELETE FROM cache WHERE expires_at <= ?", [now]);
    return result.changes;
  } finally {
    db.close();
  }
}

/**
 * Wipe the entire cache table.
 */
export function clearAll(dbPath?: string): void {
  const db = getConnection(dbPath);
  try {
    db.run("DELETE FROM cache");
  } finally {
    db.close();
  }
}

/**
 * Return seconds since cache entry was written, or null if not found/expired.
 * Derived from expires_at and ttl (no written_at column stored).
 * Mirrors: max(0, ttl - (expires_at - now))
 */
export function cacheAge(key: string, dbPath?: string): number | null {
  const db = getConnection(dbPath);
  try {
    const now = Math.floor(Date.now() / 1000);
    const row = db
      .query<ExpiresRow, [string]>(
        "SELECT expires_at FROM cache WHERE key = ?"
      )
      .get(key);

    if (row === null || row.expires_at <= now) return null;

    const ttl = getTtl(key);
    return Math.max(0, ttl - (row.expires_at - now));
  } finally {
    db.close();
  }
}
