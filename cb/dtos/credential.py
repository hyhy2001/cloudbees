from __future__ import annotations
"""Credential DTOs -- UsernamePassword focused."""

import dataclasses
from cb.dtos.base import BaseDTO


@dataclasses.dataclass
class CredentialDTO(BaseDTO):
    id: str = ""
    display_name: str = ""
    type_name: str = ""
    scope: str = "GLOBAL"
    description: str = ""

    @classmethod
    def from_dict(cls, data: dict) -> "CredentialDTO":
        return cls(
            id=data.get("id", ""),
            display_name=data.get("displayName", ""),
            type_name=data.get("typeName", ""),
            scope=data.get("scope", "GLOBAL"),
            description=data.get("description", ""),
        )
