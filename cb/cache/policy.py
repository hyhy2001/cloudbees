"""Cache TTL policy constants (seconds) per resource type."""
from __future__ import annotations

# How long each resource type stays in cache
TTL: dict[str, int] = {
    "jobs.list":          300,
    "jobs.detail":        300,
    "controllers.list":   86400,
    "controllers.detail": 86400,
    "controllers.capabilities": 300,
    "credentials.list":   300,
    "credentials.detail": 300,
    "nodes.list":         300,
    "nodes.detail":       300,
}

DEFAULT_TTL = 60


def get_ttl(resource_key: str) -> int:
    """Return TTL for a given resource key, falling back to DEFAULT_TTL."""
    return TTL.get(resource_key, DEFAULT_TTL)
