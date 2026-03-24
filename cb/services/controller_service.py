from __future__ import annotations
"""Controller service — list, get, select active controller."""

from pathlib import Path
from typing import Optional, List, Tuple

from cb.api.client import CloudBeesClient
from cb.dtos.controller import ControllerDTO


# Known controller class names from CloudBees CI / Jenkins
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
        # Include known controller types + generic Masters
        if any(c in cls for c in ("Master", "Controller", "ConnectedMaster", "ManagedMaster")):
            controllers.append(ControllerDTO.from_dict(j))
    # If none found, treat all top-level items as potential controllers
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
    url = get_setting("active_controller_url", db_path)
    if name and url:
        return (name, url)
    return None
