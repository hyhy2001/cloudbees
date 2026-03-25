from __future__ import annotations
"""Sync Service for portable offline database."""
from pathlib import Path
import logging

from cb.api.client import CloudBeesClient
from cb.services.job_service import list_jobs
from cb.services.node_service import list_nodes
from cb.services.pipeline_service import list_pipelines

from cb.db.repositories.job_repo import save_jobs
from cb.db.repositories.node_repo import save_nodes
from cb.db.repositories.pipeline_repo import save_pipelines

logger = logging.getLogger(__name__)

def sync_all(client: CloudBeesClient, db_path: Path | None = None) -> dict[str, int]:
    """
    Fetches all primary entities (Jobs, Nodes, Pipelines) from CloudBees API
    and persists them into the local offline SQLite database.
    Returns a dictionary of counts synced.
    """
    result = {"jobs": 0, "nodes": 0, "pipelines": 0}

    # 1. Sync Jobs
    try:
        jobs = list_jobs(client)
        save_jobs(jobs, db_path)
        result["jobs"] = len(jobs)
        logger.debug(f"Synced {len(jobs)} jobs.")
    except Exception as e:
        logger.error(f"Failed to sync jobs: {e}")

    # 2. Sync Nodes
    try:
        nodes = list_nodes(client)
        save_nodes(nodes, db_path)
        result["nodes"] = len(nodes)
        logger.debug(f"Synced {len(nodes)} nodes.")
    except Exception as e:
        logger.error(f"Failed to sync nodes: {e}")

    # 3. Sync Pipelines
    try:
        pipelines = list_pipelines(client)
        save_pipelines(pipelines, db_path)
        result["pipelines"] = len(pipelines)
        logger.debug(f"Synced {len(pipelines)} pipelines.")
    except Exception as e:
        logger.error(f"Failed to sync pipelines: {e}")

    return result
