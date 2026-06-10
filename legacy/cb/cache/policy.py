"""Cache TTL policy constants (seconds) per resource type."""
from __future__ import annotations

# How long each resource type stays in cache.
# Kept short so status changes (node offline, job result) appear quickly.
TTL: dict[str, int] = {
    "jobs.list":                  10,
    "jobs.detail":                10,
    "controllers.list":           10,
    "controllers.detail":         10,
    "controllers.capabilities":   10,
    "credentials.list":           10,
    "credentials.detail":         10,
    "nodes.list":                 10,
    "nodes.detail":               10,
}

DEFAULT_TTL = 10


def get_ttl(resource_key: str) -> int:
    """Return TTL for a given resource key, falling back to DEFAULT_TTL."""
    for prefix, ttl in TTL.items():
        if resource_key.startswith(prefix):
            return ttl
    return DEFAULT_TTL
