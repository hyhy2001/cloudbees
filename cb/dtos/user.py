"""User-related DTOs."""

from __future__ import annotations
import dataclasses
from typing import Any
from cb.dtos.base import BaseDTO


@dataclasses.dataclass
class UserDTO(BaseDTO):
    id: str = ""
    full_name: str = ""
    description: str = ""
    url: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> UserDTO:
        return cls(
            id=data.get("id", ""),
            full_name=data.get("fullName", ""),
            description=data.get("description", ""),
            url=data.get("absoluteUrl", ""),
        )


@dataclasses.dataclass
class TeamDTO(BaseDTO):
    name: str = ""
    description: str = ""
    members: list[str] = dataclasses.field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TeamDTO:
        return cls(
            name=data.get("name", ""),
            description=data.get("description", ""),
            members=data.get("members", []),
        )
