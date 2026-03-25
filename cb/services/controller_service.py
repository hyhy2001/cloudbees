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


def get_active_controller(db_path: Optional[Path] = None, client: Optional[CloudBeesClient] = None) -> Optional[Tuple[str, str]]:
    """Return (name, url) of the active controller, or None."""
    from cb.db.repositories.settings_repo import get_setting
    name = get_setting("active_controller", db_path)
    if not name:
        return None

    url = get_setting("active_controller_url", db_path)
    if not url:
        # Fallback if DB didn't have URL
        if client:
            base = client.base_url.rstrip("/")
            if base.endswith("/cjoc"):
                base = base[:-5]
            url = f"{base}/cjoc/job/{name}/"
        else:
            url = f"/cjoc/job/{name}/"

    import re
    url = re.sub(rf"/cjoc/job/{re.escape(name)}/?", f"/{name}/", url)

    return (name, url)


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

    # Default base labels
    if "ManagedMaster" in cls:
        label = "Managed Master"
    elif "ConnectedMaster" in cls:
        label = "Connected Master"
    elif "Beekeeper" in cls:
        label = "Upgrading..."
    else:
        label = cls.split(".")[-1] if cls else "Unknown"

    if "Beekeeper" in cls:
        job, node, cred = False, False, False
    else:
        # Dynamic Permission Probing
        from cb.api.exceptions import AuthError, NotFoundError, APIError

        # 1. Job Probe (read root or job list to see if we have access)
        try:
            client.get(f"/{name}/api/json?tree=jobs[name]")
            job = True
        except (AuthError, NotFoundError, APIError):
            job = False

        # 2. Node Probe (read computer api)
        try:
            client.get(f"/{name}/computer/api/json?tree=computer[displayName]")
            node = True
        except (AuthError, NotFoundError, APIError):
            node = False

        # 3. Credential Probe (read user credential store)
        try:
            # We don't have username passed in directly here, so we try the system domain or a simple endpoint
            # Actually, standard CloudBees client has session info if we access via active profile.
            # But we can try hitting the basic credential store plugin endpoint.
            # Even a 404 means the plugin exists and we aren't completely 403.
            # However, testing /credentials/store/system/domain/_/api/json works.
            client.get(f"/{name}/credentials/store/system/domain/_/api/json")
            cred = True
        except AuthError:
            cred = False
        except (NotFoundError, APIError):
            # If 404, we have read access to the controller but maybe no system creds.
            # Still means we passed the 403 test.
            cred = True

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
