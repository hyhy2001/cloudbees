"""SQLite3 connection and database initialisation."""

from __future__ import annotations

import os
import sys
import contextlib
import sqlite3
from pathlib import Path
from typing import Optional

_DB_PATH: Optional[Path] = None


def _detect_bee_root() -> Optional[Path]:
    """Best-effort detection of bee project root directory."""
    # 1) Explicit root override
    bee_dir = os.environ.get("BEE_DIR")
    if bee_dir:
        p = Path(bee_dir).expanduser().resolve()
        if p.exists():
            return p

    # 2) Running inside project-local virtualenv: <root>/.venv/bin/python
    try:
        exe = Path(sys.executable).resolve()
        if exe.parent.name == "bin" and exe.parent.parent.name == ".venv":
            root = exe.parent.parent.parent
            if root.exists():
                return root
    except Exception:
        pass

    # 3) Running from source tree: walk up from this module for pyproject/cb markers
    try:
        cur = Path(__file__).resolve()
        for parent in cur.parents:
            if (parent / "pyproject.toml").exists() and (parent / "cb").is_dir():
                return parent
    except Exception:
        pass

    return None


def get_db_path() -> Path:
    """Return the database file path, respecting CB_DB_PATH env override.

    Priority:
      1. CB_DB_PATH environment variable
      2. <bee_root>/data/cb.db (auto-detected)
    """
    global _DB_PATH
    if _DB_PATH is not None:
        return _DB_PATH

    env = os.environ.get("CB_DB_PATH")
    if env:
        _DB_PATH = Path(env)
    else:
        bee_root = _detect_bee_root()
        if not bee_root:
            raise RuntimeError(
                "Cannot determine bee database location. "
                "Set BEE_DIR or CB_DB_PATH explicitly."
            )
        data_dir = bee_root / "data"
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
    conn.execute("PRAGMA journal_mode = DELETE")  # NOT WAL -- 3.7 compat
    return conn

@contextlib.contextmanager
def get_db(db_path: Optional[Path] = None):
    """Context manager for auto-closing database connections."""
    conn = get_connection(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(db_path: Optional[Path] = None) -> None:
    """Create tables from schema.sql if they don't already exist."""
    schema_file = Path(__file__).parent / "schema.sql"
    sql = schema_file.read_text(encoding="utf-8")

    conn = get_connection(db_path)
    try:
        conn.executescript(sql)
        # Automatic transparent migration: add missing columns to user_resources
        try:
            conn.execute("ALTER TABLE user_resources ADD COLUMN controller_name TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass  # Column likely already exists
            
        conn.commit()
    finally:
        conn.close()


def set_db_path(path: Path) -> None:
    """Override DB path (used in tests for in-memory or temp DBs)."""
    global _DB_PATH
    _DB_PATH = path
