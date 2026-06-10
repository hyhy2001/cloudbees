from __future__ import annotations
"""CloudBees REST API exceptions."""


class CBError(Exception):
    """Base exception for all CB errors."""


class APIError(CBError):
    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        super().__init__(f"HTTP {status_code}: {message}")


class AuthError(CBError):
    """Raised when credentials are missing or invalid (401/403)."""


class NotFoundError(CBError):
    """Raised when a resource does not exist (404)."""


class ConnectionError(CBError):
    """Raised when the server is unreachable."""
