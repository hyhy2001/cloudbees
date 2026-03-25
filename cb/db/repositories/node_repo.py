from __future__ import annotations
import time
from pathlib import Path
from cb.db.connection import get_db
from cb.dtos.node import NodeDTO

def save_nodes(nodes: list[NodeDTO], db_path: Path | None = None) -> None:
    now = int(time.time())
    with get_db(db_path) as conn:
        conn.execute("DELETE FROM nodes")
        for n in nodes:
            conn.execute(
                """
                INSERT INTO nodes (name, offline, num_executors, labels, description, last_updated)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (n.name, int(n.offline), n.num_executors, n.labels, n.description, now)
            )
        conn.commit()

def list_nodes(db_path: Path | None = None) -> list[NodeDTO]:
    with get_db(db_path) as conn:
        cursor = conn.execute("SELECT name, offline, num_executors, labels, description FROM nodes ORDER BY name ASC")
        rows = cursor.fetchall()

    return [
        NodeDTO(
            name=row["name"],
            display_name=row["name"],
            offline=bool(row["offline"]),
            num_executors=row["num_executors"] or 1,
            labels=row["labels"] or "",
            description=row["description"] or ""
        ) for row in rows
    ]
