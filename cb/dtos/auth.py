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

