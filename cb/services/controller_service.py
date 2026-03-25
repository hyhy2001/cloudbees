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


def resolve_controller_url(client: CloudBeesClient, cjoc_url: str) -> str:
    """Follow the CJOC 302 redirect to find the real Ingress URL, stripping SSO suffixes."""
    real_url = client.resolve_redirect(cjoc_url)
    if real_url:
        if "operations-center-sso-navigate" in real_url:
            real_url = real_url.split("operations-center-sso-navigate")[0]
        return real_url
    return cjoc_url


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
        # Resolve real URL from CJOC proxy URL
        real_url = resolve_controller_url(client, dto.url)
        # Use a dedicated client bound to the controller's real URL
        ctrl_client = CloudBeesClient(real_url, client._token)

        # 1. Job Probe 
        try:
            ctrl_client.post("/createItem?name=probe_test")
            job = True
        except (AuthError, NotFoundError):
            job = False
        except APIError as e:
            # 400 Bad Request indicates we are allowed to hit the endpoint but missing the XML payload
            job = getattr(e, "status_code", 404) == 400

        # 2. Node Probe
        try:
            ctrl_client.post("/computer/doCreateItem?name=probe_tester&type=hudson.slaves.DumbSlave")
            node = True
        except (AuthError, NotFoundError):
            node = False
        except APIError as e:
            node = getattr(e, "status_code", 404) == 400

        # 3. Credential Probe
        try:
            from cb.services.credential_service import _get_user_seg
            user_seg = _get_user_seg("")
            ctrl_client.post(f"{user_seg}/createCredentials")
            cred = True
        except (AuthError, NotFoundError):
            cred = False
        except APIError as e:
            # allow 405 Method Not Allowed as it also proves endpoint visibility
            cred = getattr(e, "status_code", 404) in (400, 405)

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
