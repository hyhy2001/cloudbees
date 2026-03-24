from __future__ import annotations
"""Node / Agent DTOs."""

import dataclasses
from cb.dtos.base import BaseDTO


@dataclasses.dataclass
class NodeDTO(BaseDTO):
    name: str = ""
    display_name: str = ""
    offline: bool = False
    num_executors: int = 1
    labels: str = ""
    description: str = ""

    @classmethod
    def from_dict(cls, data: dict) -> "NodeDTO":
        return cls(
            name=data.get("displayName", data.get("name", "")),
            display_name=data.get("displayName", ""),
            offline=data.get("offline", False),
            num_executors=data.get("numExecutors", 1),
            labels=data.get("assignedLabels", [{}])[0].get("name", "") if data.get("assignedLabels") else "",
            description=data.get("description", ""),
        )


@dataclasses.dataclass
class NodeDetailDTO(NodeDTO):
    launcher_type: str = ""   # jnlp / ssh / command
    remote_dir: str = ""
    config_xml: str = ""      # raw XML, used for copy-node

    @classmethod
    def from_dict(cls, data: dict) -> "NodeDetailDTO":
        base = NodeDTO.from_dict(data)
        launcher = data.get("launcher", {})
        launcher_class = launcher.get("_class", "") if isinstance(launcher, dict) else ""
        if "JNLP" in launcher_class or "Inbound" in launcher_class:
            ltype = "jnlp"
        elif "SSH" in launcher_class:
            ltype = "ssh"
        else:
            ltype = launcher_class.split(".")[-1].lower()

        return cls(
            name=base.name,
            display_name=base.display_name,
            offline=base.offline,
            num_executors=base.num_executors,
            labels=base.labels,
            description=base.description,
            launcher_type=ltype,
            remote_dir=data.get("remoteFS", ""),
        )
