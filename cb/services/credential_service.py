from __future__ import annotations
"""Credential service — controller-scoped for CloudBees CI / OC."""

from pathlib import Path
from typing import Optional, List

from cb.api.client import CloudBeesClient
from cb.api.xml_builder import build_username_password_cred_xml
from cb.dtos.credential import CredentialDTO


def _cred_base(db_path: Optional[Path] = None, controller_name: Optional[str] = None) -> str:
    """Return the credentials store base path, scoped to active controller if available."""
    ctrl = controller_name
    if ctrl is None and db_path is not None:
        from cb.services.controller_service import get_active_controller
        active = get_active_controller(db_path)
        ctrl = active[0] if active else None
    if ctrl:
        return f"/job/{ctrl}/credentials/store/system/domain/_"
    return "/credentials/store/system/domain/_"


def list_credentials(
    client: CloudBeesClient,
    db_path: Optional[Path] = None,
    controller_name: Optional[str] = None,
) -> List[CredentialDTO]:
    base      = _cred_base(db_path, controller_name)
    cache_key = f"credentials.list.{controller_name or '_root'}"
    data = client.get(
        f"{base}/api/json?tree=credentials[id,displayName,typeName,scope,description]",
        cache_key=cache_key,
    )
    return [CredentialDTO.from_dict(c) for c in (data or {}).get("credentials", [])]


def get_credential(
    client: CloudBeesClient,
    cred_id: str,
    db_path: Optional[Path] = None,
    controller_name: Optional[str] = None,
) -> CredentialDTO:
    base = _cred_base(db_path, controller_name)
    data = client.get(
        f"{base}/{cred_id}/api/json",
        cache_key=f"credentials.detail.{cred_id}",
    )
    return CredentialDTO.from_dict(data or {})


def create_username_password(
    client: CloudBeesClient,
    cred_id: str,
    username: str,
    password: str,
    desc: str = "",
    scope: str = "GLOBAL",
    db_path: Optional[Path] = None,
    controller_name: Optional[str] = None,
) -> None:
    """Create a Username+Password credential via POST XML."""
    base = _cred_base(db_path, controller_name)
    xml  = build_username_password_cred_xml(
        cred_id=cred_id,
        username=username,
        password=password,
        desc=desc,
        scope=scope,
    )
    client.post_xml(
        f"{base}/createCredentials",
        xml_str=xml,
        invalidate="credentials.",
    )


def delete_credential(
    client: CloudBeesClient,
    cred_id: str,
    db_path: Optional[Path] = None,
    controller_name: Optional[str] = None,
) -> None:
    """Delete a credential by ID."""
    base = _cred_base(db_path, controller_name)
    client.post(
        f"{base}/{cred_id}/doDelete",
        invalidate="credentials.",
    )
