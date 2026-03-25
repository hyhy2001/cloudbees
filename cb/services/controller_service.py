from __future__ import annotations
"""Controller service - list, get, select active controller."""

import dataclasses
from pathlib import Path
from typing import Optional, List, Tuple

from cb.api.client import CloudBeesClient
from cb.dtos.controller import ControllerDTO


_CONTROLLER_CLASSES = {
    "com.cloudbees.opscenter.server.model.ManagedMaster",
    "com.cloudbees.opscenter.server.model.ConnectedMaster",
    "com.cloudbees.opscenter.server.model.BeekeeperUpgradeMaster",
}


def list_controllers(client: CloudBeesClient) -> List[ControllerDTO]:
    """List all controllers visible to this CloudBees server."""
    data = client.get(
        "/api/json?tree=jobs[_class,name,url,description,offline]",
        cache_key="controllers.list",
    )
    jobs = (data or {}).get("jobs", [])
    controllers = []
    for j in jobs:
        cls = j.get("_class", "")
        if any(c in cls for c in ("Master", "Controller", "ConnectedMaster", "ManagedMaster")):
            controllers.append(ControllerDTO.from_dict(j))
    if not controllers:
        controllers = [ControllerDTO.from_dict(j) for j in jobs]
    return controllers


def get_controller(client: CloudBeesClient, name: str) -> ControllerDTO:
    data = client.get(f"/job/{name}/api/json", cache_key=f"controllers.detail.{name}")
    return ControllerDTO.from_dict(data or {})


def select_controller(name: str, url: str, db_path: Optional[Path] = None) -> None:
    """Persist the active controller selection to the settings table."""
    from cb.db.repositories.settings_repo import set_setting
    set_setting("active_controller", name, db_path)
    set_setting("active_controller_url", url, db_path)


def get_active_controller(db_path: Optional[Path] = None) -> Optional[Tuple[str, str]]:
    """Return (name, url) of the active controller, or None."""
    from cb.db.repositories.settings_repo import get_setting
    name = get_setting("active_controller", db_path)
    url  = get_setting("active_controller_url", db_path)
    if name and url:
        return (name, url)
    return None


# -- Controller capability info -----------------------------------------------


@dataclasses.dataclass
class CapabilityInfo:
    name:            str
    url:             str
    type_label:      str
    online:          bool
    can_create_job:  bool
    can_create_node: bool
    can_create_cred: bool
    description:     str


def get_controller_capabilities(
    client: CloudBeesClient,
    name: str,
) -> CapabilityInfo:
    """Fetch controller detail and derive create permissions from _class."""
    dto = get_controller(client, name)
    cls = dto.class_name

    if not dto.online:
        return CapabilityInfo(
            name=dto.name, url=dto.url, description=dto.description,
            type_label="Offline", online=False,
            can_create_job=False, can_create_node=False, can_create_cred=False,
        )

    if "ManagedMaster" in cls:
        label, job, node, cred = "Managed Master", True, True, True
    elif "ConnectedMaster" in cls:
        label, job, node, cred = "Connected Master", True, False, True
    elif "Beekeeper" in cls:
        label, job, node, cred = "Upgrading...", False, False, False
    else:
        short = cls.split(".")[-1] if cls else "Unknown"
        label, job, node, cred = short, True, True, True

    return CapabilityInfo(
        name=dto.name,
        url=dto.url,
        description=dto.description or "",
        type_label=label,
        online=True,
        can_create_job=job,
        can_create_node=node,
        can_create_cred=cred,
    )
