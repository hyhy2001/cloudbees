from __future__ import annotations
"""CSRF crumb fetcher for CloudBees/Jenkins POST requests."""

import time
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from cb.api.client import CloudBeesClient

_crumb_cache: dict = {}  # keyed by client base_url
_CRUMB_TTL = 300  # 5 minutes


def get_crumb(client: "CloudBeesClient") -> Optional[dict]:
    """
    Fetch (or return cached) CSRF crumb for this CloudBees server.
    Returns {"field": "Jenkins-Crumb", "value": "abc123"} or None.
    """
    key = client.base_url
    entry = _crumb_cache.get(key)
    if entry and time.time() < entry["expires_at"]:
        return entry["crumb"]

    try:
        data = client._request("GET", "/crumbIssuer/api/json")
        if data and "crumb" in data:
            crumb = {
                "field": data.get("crumbRequestField", "Jenkins-Crumb"),
                "value": data["crumb"],
            }
            _crumb_cache[key] = {
                "crumb": crumb,
                "expires_at": time.time() + _CRUMB_TTL,
            }
            return crumb
    except Exception:
        pass  # Server may not have CSRF protection enabled
    return None


def invalidate_crumb(base_url: str) -> None:
    """Remove cached crumb for a server (call after 403 response)."""
    _crumb_cache.pop(base_url, None)
