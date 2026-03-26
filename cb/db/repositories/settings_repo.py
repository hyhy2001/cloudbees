from __future__ import annotations
"""Settings repository -- simple key/value store in SQLite."""

from pathlib import Path
from typing import Optional

from cb.db.connection import get_connection


def get_setting(key: str, db_path: Optional[Path] = None) -> Optional[str]:
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else None
    finally:
        conn.close()


def set_setting(key: str, value: str, db_path: Optional[Path] = None) -> None:
    conn = get_connection(db_path)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, value),
        )
        conn.commit()
    finally:
        conn.close()


def delete_setting(key: str, db_path: Optional[Path] = None) -> None:
    conn = get_connection(db_path)
    try:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
        conn.commit()
    finally:
        conn.close()
