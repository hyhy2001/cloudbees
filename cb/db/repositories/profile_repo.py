"""Profile and token repository — SQLite3 CRUD."""

from __future__ import annotations
import time
from pathlib import Path

from cb.db.connection import get_connection
from cb.dtos.auth import ProfileDTO


# ── Profile repo ──────────────────────────────────────────────


def save_profile(
    name: str,
    server_url: str,
    username: str,
    is_default: bool = False,
    db_path: Path | None = None,
) -> ProfileDTO:
    now = int(time.time())
    conn = get_connection(db_path)
    try:
        if is_default:
            conn.execute("UPDATE profiles SET is_default = 0")

        # UPDATE existing profile (preserves id so token FK stays valid)
        cur = conn.execute(
            """UPDATE profiles
               SET server_url = ?, username = ?, is_default = ?
               WHERE name = ?""",
            (server_url.rstrip("/"), username, int(is_default), name),
        )
        if cur.rowcount == 0:
            # New profile — INSERT
            conn.execute(
                """INSERT INTO profiles
                   (name, server_url, username, is_default, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (name, server_url.rstrip("/"), username, int(is_default), now),
            )
        conn.commit()
        return get_profile(name, db_path)
    finally:
        conn.close()


def get_profile(name: str, db_path: Path | None = None) -> ProfileDTO:
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM profiles WHERE name = ?", (name,)
        ).fetchone()
        if row is None:
            raise ValueError(f"Profile '{name}' not found.")
        return ProfileDTO(
            id=row["id"],
            name=row["name"],
            server_url=row["server_url"],
            username=row["username"],
            is_default=bool(row["is_default"]),
            created_at=row["created_at"],
        )
    finally:
        conn.close()


def get_default_profile(db_path: Path | None = None) -> ProfileDTO | None:
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM profiles WHERE is_default = 1 LIMIT 1"
        ).fetchone()
        if row is None:
            # Fall back to the first profile created
            row = conn.execute(
                "SELECT * FROM profiles ORDER BY created_at LIMIT 1"
            ).fetchone()
        if row is None:
            return None
        return ProfileDTO(
            id=row["id"],
            name=row["name"],
            server_url=row["server_url"],
            username=row["username"],
            is_default=bool(row["is_default"]),
            created_at=row["created_at"],
        )
    finally:
        conn.close()


def list_profiles(db_path: Path | None = None) -> list[ProfileDTO]:
    conn = get_connection(db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM profiles ORDER BY is_default DESC, created_at"
        ).fetchall()
        return [
            ProfileDTO(
                id=r["id"],
                name=r["name"],
                server_url=r["server_url"],
                username=r["username"],
                is_default=bool(r["is_default"]),
                created_at=r["created_at"],
            )
            for r in rows
        ]
    finally:
        conn.close()


def delete_profile(name: str, db_path: Path | None = None) -> None:
    conn = get_connection(db_path)
    try:
        conn.execute("DELETE FROM profiles WHERE name = ?", (name,))
        conn.commit()
    finally:
        conn.close()


