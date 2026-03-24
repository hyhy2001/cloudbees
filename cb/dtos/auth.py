"""Auth / profile DTOs (local DB, not from API)."""

from __future__ import annotations
import dataclasses
from cb.dtos.base import BaseDTO


@dataclasses.dataclass
class ProfileDTO(BaseDTO):
    id: int = 0
    name: str = ""
    server_url: str = ""
    username: str = ""
    is_default: bool = False
    created_at: int = 0


@dataclasses.dataclass
class TokenDTO(BaseDTO):
    id: int = 0
    profile_id: int = 0
    enc_token: bytes = b""
    salt: bytes = b""
    expires_at: int | None = None
    updated_at: int = 0
