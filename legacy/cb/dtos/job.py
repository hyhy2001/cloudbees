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
    job_class: str = ""      # Freestyle / WorkflowJob / Folder
    job_type: str = ""       # FS / PL / FD (display shorthand)

    @classmethod
    def from_dict(cls, data: dict) -> "JobDTO":
        class_name = data.get("_class", "")
        if "FreeStyle" in class_name or "freestyle" in class_name.lower():
            jtype = "FS"
        elif "WorkflowJob" in class_name or "workflow.job" in class_name:
            jtype = "PL"
        elif "Folder" in class_name or "folder" in class_name.lower():
            jtype = "FD"
        elif "MultiBranch" in class_name:
            jtype = "MB"
        else:
            jtype = class_name.split(".")[-1][:4] if class_name else ""

        return cls(
            id=data.get("name", ""),
            name=data.get("name", ""),
            url=data.get("url", ""),
            color=data.get("color", ""),
            buildable=data.get("buildable", True),
            last_build_number=data.get("lastBuild", {}).get("number") if data.get("lastBuild") else None,
            last_build_url=data.get("lastBuild", {}).get("url") if data.get("lastBuild") else None,
            description=data.get("description", ""),
            job_class=class_name,
            job_type=jtype,
        )


@dataclasses.dataclass
class BuildDTO(BaseDTO):
    number: int = 0
    result: str = ""          # SUCCESS / FAILURE / ABORTED / "" (in progress)
    building: bool = False
    duration: int = 0
    timestamp: int = 0
    url: str = ""

    @classmethod
    def from_dict(cls, data: dict) -> "BuildDTO":
        return cls(
            number=data.get("number", 0),
            result=data.get("result") or "",
            building=data.get("building", False),
            duration=data.get("duration", 0),
            timestamp=data.get("timestamp", 0),
            url=data.get("url", ""),
        )


@dataclasses.dataclass
class JobConfigDTO(BaseDTO):
    name: str = ""
    job_type: str = ""   # freestyle | pipeline | folder
    description: str = ""

