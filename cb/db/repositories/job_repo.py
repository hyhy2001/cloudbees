from __future__ import annotations
import time
from pathlib import Path
from cb.db.connection import get_db
from cb.dtos.job import JobDTO

def save_jobs(jobs: list[JobDTO], db_path: Path | None = None) -> None:
    now = int(time.time())
    with get_db(db_path) as conn:
        conn.execute("DELETE FROM jobs")
        for j in jobs:
            conn.execute(
                """
                INSERT INTO jobs (name, job_type, color, build_number, description, last_updated)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (j.name, j.job_type, j.color, j.last_build_number, j.description, now)
            )
        conn.commit()

def list_jobs(db_path: Path | None = None) -> list[JobDTO]:
    with get_db(db_path) as conn:
        cursor = conn.execute("SELECT name, job_type, color, build_number, description FROM jobs ORDER BY name ASC")
        rows = cursor.fetchall()
        
    return [
        JobDTO(
            id=row["name"],
            name=row["name"],
            job_type=row["job_type"] or "",
            color=row["color"] or "",
            last_build_number=row["build_number"],
            description=row["description"] or ""
        ) for row in rows
    ]
