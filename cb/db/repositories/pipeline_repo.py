from __future__ import annotations
import time
from pathlib import Path
from cb.db.connection import get_db
from cb.dtos.pipeline import PipelineDTO

def save_pipelines(pipelines: list[PipelineDTO], db_path: Path | None = None) -> None:
    now = int(time.time())
    with get_db(db_path) as conn:
        conn.execute("DELETE FROM pipelines")
        for p in pipelines:
            conn.execute(
                """
                INSERT INTO pipelines (name, status, branch, description, last_updated)
                VALUES (?, ?, ?, ?, ?)
                """,
                (p.name, p.status, p.branch, p.description, now)
            )
        conn.commit()

def list_pipelines(db_path: Path | None = None) -> list[PipelineDTO]:
    with get_db(db_path) as conn:
        cursor = conn.execute("SELECT name, status, branch, description FROM pipelines ORDER BY name ASC")
        rows = cursor.fetchall()

    return [
        PipelineDTO(
            id=row["name"],
            name=row["name"],
            status=row["status"] or "",
            branch=row["branch"] or "",
            description=row["description"] or ""
        ) for row in rows
    ]
