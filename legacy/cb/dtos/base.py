"""Base DTO with stdlib-only from_dict / to_dict helpers."""

from __future__ import annotations
import dataclasses
from typing import Any


@dataclasses.dataclass
class BaseDTO:
    """All DTOs inherit from this class."""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BaseDTO":
        """
        Construct an instance from a raw dict.
        Only uses fields declared in the dataclass; unknown keys are silently ignored.
        Missing optional fields use their default values.
        """
        fields = {f.name for f in dataclasses.fields(cls)}
        kwargs = {k: v for k, v in data.items() if k in fields}
        return cls(**kwargs)

    def to_dict(self) -> dict[str, Any]:
        """Serialise the DTO to a plain dict (suitable for json.dumps)."""
        return dataclasses.asdict(self)
