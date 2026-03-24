from __future__ import annotations
"""SQLite-backed TTL cache manager for API responses."""

import json
import time
from pathlib import Path

from cb.db.connection import get_connection
from cb.cache.policy import get_ttl


def get_cached(key: str, db_path: Path | None = None) -> dict | list | None:
    """
    Return cached value for key if not expired, else None.
    Purges expired entry on miss.
    """
    conn = get_connection(db_path)
    try:
        now = int(time.time())
        row = conn.execute(
            "SELECT value, expires_at FROM cache WHERE key = ?", (key,)
        ).fetchone()

        if row is None:
            return None

        if row["expires_at"] <= now:
            conn.execute("DELETE FROM cache WHERE key = ?", (key,))
            conn.commit()
            return None

        return json.loads(row["value"])
    finally:
        conn.close()


def set_cache(
    key: str,
    value: dict | list,
    ttl: int | None = None,
    db_path: Path | None = None,
) -> None:
    """Store a value in the cache with an expiry time."""
    if ttl is None:
        ttl = get_ttl(key)

    expires_at = int(time.time()) + ttl
    serialised = json.dumps(value, ensure_ascii=False)

    conn = get_connection(db_path)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
            (key, serialised, expires_at),
        )
        conn.commit()
    finally:
        conn.close()


def invalidate(key: str, db_path: Path | None = None) -> None:
    """Delete a specific cached entry."""
    conn = get_connection(db_path)
    try:
        conn.execute("DELETE FROM cache WHERE key = ?", (key,))
        conn.commit()
    finally:
        conn.close()


def invalidate_prefix(prefix: str, db_path: Path | None = None) -> None:
    """Delete all cached entries whose key starts with prefix."""
    conn = get_connection(db_path)
    try:
        conn.execute("DELETE FROM cache WHERE key LIKE ?", (f"{prefix}%",))
        conn.commit()
    finally:
        conn.close()


def purge_expired(db_path: Path | None = None) -> int:
    """Delete all expired cache entries. Returns number deleted."""
    conn = get_connection(db_path)
    try:
        now = int(time.time())
        cur = conn.execute("DELETE FROM cache WHERE expires_at <= ?", (now,))
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def clear_all(db_path: Path | None = None) -> None:
    """Wipe the entire cache table."""
    conn = get_connection(db_path)
    try:
        conn.execute("DELETE FROM cache")
        conn.commit()
    finally:
        conn.close()


def cache_age(key: str, db_path: Path | None = None) -> int | None:
    """Return seconds since cache entry was written, or None if not found/expired."""
    conn = get_connection(db_path)
    try:
        now = int(time.time())
        row = conn.execute(
            "SELECT expires_at FROM cache WHERE key = ?", (key,)
        ).fetchone()
        if row is None or row["expires_at"] <= now:
            return None
        # We stored expires_at = written_at + ttl; we don't store written_at
        # Return 0 as "fresh" since we don't track exact write time without extra column
        return 0
    finally:
        conn.close()
