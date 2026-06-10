from __future__ import annotations
import time
from pathlib import Path
from typing import List

from cb.db.connection import get_connection

def track_resource(
    resource_type: str,
    name: str,
    profile_name: str,
    controller_name: str = "",
    db_path: Path | None = None,
) -> None:
    now = int(time.time())
    conn = get_connection(db_path)
    try:
        conn.execute(
            """INSERT OR REPLACE INTO user_resources 
               (resource_type, name, profile_name, controller_name, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (resource_type, name, profile_name, controller_name, now)
        )
        conn.commit()
    finally:
        conn.close()

def untrack_resource(
    resource_type: str,
    name: str,
    profile_name: str,
    controller_name: str = "",
    db_path: Path | None = None,
) -> None:
    conn = get_connection(db_path)
    try:
        conn.execute(
            """DELETE FROM user_resources 
               WHERE resource_type = ? AND name = ? AND profile_name = ? AND controller_name = ?""",
            (resource_type, name, profile_name, controller_name)
        )
        conn.commit()
    finally:
        conn.close()

def get_tracked_resources(
    resource_type: str,
    profile_name: str,
    controller_name: str = "",
    db_path: Path | None = None,
) -> List[str]:
    conn = get_connection(db_path)
    try:
        rows = conn.execute(
            """SELECT name FROM user_resources 
               WHERE resource_type = ? AND profile_name = ? AND controller_name = ?""",
            (resource_type, profile_name, controller_name)
        ).fetchall()
        return [r["name"] for r in rows]
    finally:
        conn.close()
