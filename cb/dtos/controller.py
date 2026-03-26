from __future__ import annotations
"""Controller DTO."""

import dataclasses
from typing import Any
from cb.dtos.base import BaseDTO


@dataclasses.dataclass
class ControllerDTO(BaseDTO):
    name: str = ""
    url: str = ""
    description: str = ""
    class_name: str = ""
    online: bool = True

    @classmethod
    def from_dict(cls, data: dict) -> "ControllerDTO":
        return cls(
            name=data.get("name", ""),
            url=data.get("url", ""),
            description=data.get("description", ""),
            class_name=data.get("_class", ""),
            online=not data.get("offline", False),
        )
