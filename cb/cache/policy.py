"""Cache TTL policy constants (seconds) per resource type."""
from __future__ import annotations

# How long each resource type stays in cache.
# Kept short so status changes (node offline, job result) appear quickly.
TTL: dict[str, int] = {
    "jobs.list":                  30,
    "jobs.detail":                30,
    "controllers.list":           60,
    "controllers.detail":         60,
    "controllers.capabilities":   60,
    "credentials.list":           60,
    "credentials.detail":         60,
    "nodes.list":                 30,
    "nodes.detail":               30,
}

DEFAULT_TTL = 30


def get_ttl(resource_key: str) -> int:
    """Return TTL for a given resource key, falling back to DEFAULT_TTL."""
    for prefix, ttl in TTL.items():
        if resource_key.startswith(prefix):
            return ttl
    return DEFAULT_TTL
