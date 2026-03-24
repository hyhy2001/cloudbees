"""Cache TTL policy constants (seconds) per resource type."""
from __future__ import annotations
from typing import Dict

# How long each resource type stays in cache
TTL: Dict[str, int] = {
    "jobs.list":      60,    # changes frequently
    "jobs.detail":    30,
    "pipelines.list": 120,
    "pipelines.detail": 60,
    "users.list":     300,   # changes rarely
    "users.detail":   300,
    "system.health":  15,    # always fresh
    "system.version": 3600,  # very stable
}

DEFAULT_TTL = 60


def get_ttl(resource_key: str) -> int:
    """Return TTL for a given resource key, falling back to DEFAULT_TTL."""
    return TTL.get(resource_key, DEFAULT_TTL)
