"""CloudBees HTTP client — httpx wrapper with caching and retry."""

from __future__ import annotations
import json
import time
from pathlib import Path
from typing import Any

import httpx

from cb.api.exceptions import APIError, AuthError, NotFoundError, ConnectionError
from cb.cache.manager import get_cached, set_cache, invalidate_prefix
from cb.cache.policy import get_ttl

_RETRY_DELAYS = [1, 2, 4]  # exponential backoff seconds


class CloudBeesClient:
    """
    Thin httpx wrapper that:
    - Injects Bearer token into every request
    - Caches GET responses in SQLite with TTL
    - Retries on transient errors (5xx, timeout)
    - Invalidates related cache on write operations (POST/PUT/DELETE)
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        timeout: float = 30.0,
        db_path: Path | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout
        self._db_path = db_path

    # ── Internal helpers ──────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
        }

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = f"{self.base_url}{path}"
        last_err: Exception | None = None

        for attempt, delay in enumerate([0] + _RETRY_DELAYS):
            if delay:
                time.sleep(delay)
            try:
                resp = httpx.request(
                    method,
                    url,
                    headers=self._headers(),
                    timeout=self._timeout,
                    **kwargs,
                )
            except httpx.TimeoutException as exc:
                last_err = exc
                continue
            except httpx.RequestError as exc:
                raise ConnectionError(str(exc)) from exc

            if resp.status_code == 401:
                raise AuthError("Invalid or expired token. Run: cb login")
            if resp.status_code == 403:
                raise AuthError("Access denied (403). Check your permissions.")
            if resp.status_code == 404:
                raise NotFoundError(f"Resource not found: {path}")
            if resp.status_code >= 500 and attempt < len(_RETRY_DELAYS):
                last_err = APIError(resp.status_code, resp.text[:200])
                continue
            if not resp.is_success:
                raise APIError(resp.status_code, resp.text[:200])

            if resp.content:
                try:
                    return resp.json()
                except json.JSONDecodeError:
                    return resp.text
            return None

        raise last_err or APIError(0, "Request failed after retries")

    # ── Public API ────────────────────────────────────────────

    def get(self, path: str, cache_key: str | None = None, **kwargs: Any) -> Any:
        """GET with optional cache. Pass cache_key to enable caching."""
        if cache_key:
            cached = get_cached(cache_key, self._db_path)
            if cached is not None:
                return cached

        data = self._request("GET", path, **kwargs)

        if cache_key and data is not None:
            set_cache(cache_key, data, ttl=get_ttl(cache_key), db_path=self._db_path)

        return data

    def post(self, path: str, invalidate: str | None = None, **kwargs: Any) -> Any:
        """POST and optionally invalidate a cache prefix."""
        result = self._request("POST", path, **kwargs)
        if invalidate:
            invalidate_prefix(invalidate, self._db_path)
        return result

    def delete(self, path: str, invalidate: str | None = None, **kwargs: Any) -> Any:
        result = self._request("DELETE", path, **kwargs)
        if invalidate:
            invalidate_prefix(invalidate, self._db_path)
        return result
