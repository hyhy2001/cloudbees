"""Pipeline-related DTOs."""

from __future__ import annotations
import dataclasses
from typing import Any
from cb.dtos.base import BaseDTO


@dataclasses.dataclass
class PipelineDTO(BaseDTO):
    id: str = ""
    name: str = ""
    url: str = ""
    branch: str = ""
    status: str = ""       # e.g. SUCCESS, FAILURE, RUNNING, NOT_BUILT
    description: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PipelineDTO":
        return cls(
            id=data.get("name", ""),
            name=data.get("name", ""),
            url=data.get("url", ""),
            branch=data.get("branch", ""),
            status=data.get("color", "").upper().replace("_ANIME", ""),
            description=data.get("description", ""),
        )


@dataclasses.dataclass
class PipelineRunDTO(BaseDTO):
    id: str = ""
    number: int = 0
    url: str = ""
    status: str = ""
    start_time: int = 0
    duration: int = 0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PipelineRunDTO":
        return cls(
            id=str(data.get("id", "")),
            number=data.get("number", 0),
            url=data.get("url", ""),
            status=data.get("result") or data.get("status", "UNKNOWN"),
            start_time=data.get("startTime", 0),
            duration=data.get("durationInMillis", 0),
        )
