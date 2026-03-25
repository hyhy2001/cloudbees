"""CloudBees HTTP client — httpx wrapper with caching, CSRF crumb, and retry."""

from __future__ import annotations
import json
import time
from pathlib import Path
from typing import Any, Optional

import httpx

from cb.api.exceptions import APIError, AuthError, NotFoundError, ConnectionError
from cb.cache.manager import get_cached, set_cache, invalidate_prefix
from cb.cache.policy import get_ttl

_RETRY_DELAYS = [1, 2, 4]  # exponential backoff seconds


class CloudBeesClient:
    """
    Thin httpx wrapper that:
    - Injects Bearer/Basic token into every request
    - Auto-fetches and injects CSRF crumb into POST/DELETE requests
    - Caches GET responses in SQLite with TTL
    - Retries on transient errors (5xx, timeout)
    - Invalidates related cache on write operations
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        timeout: float = 30.0,
        db_path: Optional[Path] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout
        self._db_path = db_path

    # ── Internal helpers ──────────────────────────────────────

    def _headers(self) -> dict:
        return {
            "Authorization": f"Basic {self._token}",
            "Accept": "application/json",
        }

    def _crumb_headers(self) -> dict:
        """Get CSRF crumb headers for POST/DELETE. Returns empty dict if unavailable."""
        from cb.api.crumb import get_crumb
        crumb = get_crumb(self)
        if crumb:
            return {crumb["field"]: crumb["value"]}
        return {}

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        if path.startswith("http://") or path.startswith("https://"):
            url = path
        else:
            url = f"{self.base_url}{path}"
        last_err: Optional[Exception] = None

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
                raise AuthError("Access denied (403). Check permissions or CSRF crumb.")
            if resp.status_code == 404:
                raise NotFoundError(f"Resource not found: {path}")
            if resp.status_code >= 500 and attempt < len(_RETRY_DELAYS):
                last_err = APIError(resp.status_code, resp.text[:200])
                continue
            if not resp.is_success:
                raise APIError(resp.status_code, resp.text[:300])

            if resp.content:
                try:
                    data = resp.json()
                    import logging
                    log = logging.getLogger(__name__)
                    # Convert json to single line for debug screen
                    single_line = json.dumps(data, separators=(',', ':'))
                    log.debug(f"API [{method}] {url} -> {resp.status_code} | {single_line[:150]}...")
                    return data
                except json.JSONDecodeError:
                    import logging
                    log = logging.getLogger(__name__)
                    log.debug(f"API [{method}] {url} -> {resp.status_code} | {resp.text[:150]}...")
                    return resp.text
            import logging
            log = logging.getLogger(__name__)
            log.debug(f"API [{method}] {url} -> {resp.status_code} | (no content)")
            return None

        raise last_err or APIError(0, "Request failed after retries")

    def _write_request(self, method: str, path: str, **kwargs: Any) -> Any:
        """POST/DELETE with automatic CSRF crumb injection and 403-retry."""
        from cb.api.crumb import invalidate_crumb

        # Merge crumb into headers
        extra_headers = self._crumb_headers()
        if extra_headers:
            existing = kwargs.pop("headers", {})
            kwargs["headers"] = {**existing, **extra_headers}

        try:
            return self._request(method, path, **kwargs)
        except AuthError as exc:
            # 403 may be expired crumb — invalidate and retry once
            if "403" in str(exc):
                invalidate_crumb(self.base_url)
                new_crumb = self._crumb_headers()
                if new_crumb:
                    kwargs["headers"] = {**kwargs.get("headers", {}), **new_crumb}
                    return self._request(method, path, **kwargs)
            raise

    def resolve_redirect(self, path: str) -> Optional[str]:
        """Send a GET request without following redirects, returning the Location header if 301/302. Returns None otherwise."""
        url = path if path.startswith("http") else f"{self.base_url}{path}"
        try:
            resp = self._req.get(url, allow_redirects=False, timeout=5)
            if resp.status_code in (301, 302):
                return resp.headers.get("Location")
        except Exception as exc:
            _log.debug("Failed to resolve redirect for %s: %s", url, exc)
        return None

    # ── Public API ────────────────────────────────────────────

    def get(self, path: str, cache_key: Optional[str] = None, **kwargs: Any) -> Any:
        """GET with optional SQLite cache. Pass cache_key to enable caching."""
        if cache_key:
            cached = get_cached(cache_key, self._db_path)
            if cached is not None:
                return cached

        data = self._request("GET", path, **kwargs)

        if cache_key and data is not None:
            set_cache(cache_key, data, ttl=get_ttl(cache_key), db_path=self._db_path)

        return data

    def get_text(self, path: str, **kwargs: Any) -> str:
        """GET that returns raw text (e.g. console log, config.xml)."""
        if path.startswith("http://") or path.startswith("https://"):
            url = path
        else:
            url = f"{self.base_url}{path}"
        try:
            resp = httpx.get(
                url,
                headers=self._headers(),
                timeout=self._timeout,
                **kwargs,
            )
            if not resp.is_success:
                raise APIError(resp.status_code, resp.text[:200])
            import logging
            log = logging.getLogger(__name__)
            log.debug(f"API [GET_TEXT] {url} -> {resp.status_code} | {resp.text[:150].replace(chr(10), ' ')}...")
            return resp.text
        except httpx.RequestError as exc:
            raise ConnectionError(str(exc)) from exc

    def post(self, path: str, invalidate: Optional[str] = None, **kwargs: Any) -> Any:
        """POST with CSRF crumb injection and optional cache invalidation."""
        result = self._write_request("POST", path, **kwargs)
        if invalidate:
            invalidate_prefix(invalidate, self._db_path)
        return result

    def post_xml(self, path: str, xml_str: str, invalidate: Optional[str] = None, **kwargs: Any) -> Any:
        """POST XML payload (config.xml for jobs, nodes, credentials)."""
        from cb.api.crumb import invalidate_crumb, get_crumb

        crumb = get_crumb(self)
        headers = {"Content-Type": "text/xml;charset=UTF-8"}
        if crumb:
            headers[crumb["field"]] = crumb["value"]

        if path.startswith("http://") or path.startswith("https://"):
            url = path
        else:
            url = f"{self.base_url}{path}"
        try:
            resp = httpx.post(
                url,
                content=xml_str.encode("utf-8"),
                headers={**self._headers(), **headers},
                timeout=self._timeout,
                **kwargs,
            )
        except httpx.RequestError as exc:
            raise ConnectionError(str(exc)) from exc

        if resp.status_code == 403:
            # Stale crumb -> retry once
            invalidate_crumb(self.base_url)
            crumb = get_crumb(self)
            if crumb:
                headers[crumb["field"]] = crumb["value"]
            resp = httpx.post(
                url,
                content=xml_str.encode("utf-8"),
                headers={**self._headers(), **headers},
                timeout=self._timeout,
                **kwargs,
            )

        if not resp.is_success:
            raise APIError(resp.status_code, resp.text[:300])

        if invalidate:
            invalidate_prefix(invalidate, self._db_path)

        import logging
        log = logging.getLogger(__name__)
        raw_resp = resp.text.replace('\n', ' ') if resp.content else "(no content)"
        log.debug(f"API [POST_XML] {url} -> {resp.status_code} | {raw_resp[:150]}...")

        return resp.text if resp.content else None

    def delete(self, path: str, invalidate: Optional[str] = None, **kwargs: Any) -> Any:
        """DELETE with CSRF crumb injection."""
        result = self._write_request("DELETE", path, **kwargs)
        if invalidate:
            invalidate_prefix(invalidate, self._db_path)
        return result
