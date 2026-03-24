"""SQLite3 connection and database initialisation."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Optional

_DB_PATH: Optional[Path] = None


def get_db_path() -> Path:
    """Return the database file path, respecting CB_DB_PATH env override.

    Priority:
      1. CB_DB_PATH environment variable
      2. ./data/cb.db  (relative to current working directory)
    """
    global _DB_PATH
    if _DB_PATH is not None:
        return _DB_PATH

    env = os.environ.get("CB_DB_PATH")
    if env:
        _DB_PATH = Path(env)
    else:
        # Store data next to where the user cloned/runs the tool
        data_dir = Path.cwd() / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        _DB_PATH = data_dir / "cb.db"

    return _DB_PATH


def get_connection(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Open a database connection with sensible defaults."""
    path = db_path or get_db_path()
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    # SQLite 3.7 compatible pragmas only
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = DELETE")  # NOT WAL — 3.7 compat
    return conn


def init_db(db_path: Optional[Path] = None) -> None:
    """Create tables from schema.sql if they don't already exist."""
    schema_file = Path(__file__).parent / "schema.sql"
    sql = schema_file.read_text(encoding="utf-8")

    conn = get_connection(db_path)
    try:
        conn.executescript(sql)
        conn.commit()
    finally:
        conn.close()


def set_db_path(path: Path) -> None:
    """Override DB path (used in tests for in-memory or temp DBs)."""
    global _DB_PATH
    _DB_PATH = path

