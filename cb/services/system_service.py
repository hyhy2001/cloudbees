"""System service — health, version."""

from __future__ import annotations
from cb.api.client import CloudBeesClient


def health_check(client: CloudBeesClient) -> dict:
    """Return a dict with server health info."""
    try:
        data = client.get("/api/json?tree=_class,mode,nodeDescription,numExecutors",
                          cache_key="system.health")
        return {
            "status": "OK",
            "mode": (data or {}).get("mode", "unknown"),
            "description": (data or {}).get("nodeDescription", ""),
            "executors": (data or {}).get("numExecutors", 0),
        }
    except Exception as exc:
        return {"status": "ERROR", "message": str(exc)}


def get_version(client: CloudBeesClient) -> str:
    """Return CloudBees server version string."""
    try:
        data = client.get("/api/json?tree=_class", cache_key="system.version")
        return str((data or {}).get("_class", "unknown"))
    except Exception as exc:
        return f"Error: {exc}"
