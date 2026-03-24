"""Job-related DTOs."""

from __future__ import annotations
import dataclasses
from typing import Any
from cb.dtos.base import BaseDTO


@dataclasses.dataclass
class JobDTO(BaseDTO):
    id: str = ""
    name: str = ""
    url: str = ""
    color: str = ""          # e.g. "blue", "red", "notbuilt"
    buildable: bool = True
    last_build_number: int | None = None
    last_build_url: str | None = None
    description: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "JobDTO":
        return cls(
            id=data.get("name", ""),
            name=data.get("name", ""),
            url=data.get("url", ""),
            color=data.get("color", ""),
            buildable=data.get("buildable", True),
            last_build_number=data.get("lastBuild", {}).get("number") if data.get("lastBuild") else None,
            last_build_url=data.get("lastBuild", {}).get("url") if data.get("lastBuild") else None,
            description=data.get("description", ""),
        )


@dataclasses.dataclass
class JobRunDTO(BaseDTO):
    number: int = 0
    url: str = ""
    result: str | None = None   # SUCCESS / FAILURE / ABORTED / None (in progress)
    building: bool = False
    duration: int = 0
    timestamp: int = 0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "JobRunDTO":
        return cls(
            number=data.get("number", 0),
            url=data.get("url", ""),
            result=data.get("result"),
            building=data.get("building", False),
            duration=data.get("duration", 0),
            timestamp=data.get("timestamp", 0),
        )
