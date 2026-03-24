from __future__ import annotations
"""Credential service — UsernamePassword create/list/get/delete."""

from pathlib import Path
from typing import Optional, List

from cb.api.client import CloudBeesClient
from cb.api.xml_builder import build_username_password_cred_xml
from cb.dtos.credential import CredentialDTO

_CRED_BASE = "/credentials/store/system/domain/_"


def list_credentials(client: CloudBeesClient) -> List[CredentialDTO]:
    data = client.get(
        f"{_CRED_BASE}/api/json?tree=credentials[id,displayName,typeName,scope,description]",
        cache_key="credentials.list",
    )
    return [CredentialDTO.from_dict(c) for c in (data or {}).get("credentials", [])]


def get_credential(client: CloudBeesClient, cred_id: str) -> CredentialDTO:
    data = client.get(
        f"{_CRED_BASE}/{cred_id}/api/json",
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
) -> None:
    """Create a Username+Password credential via POST XML."""
    xml = build_username_password_cred_xml(
        cred_id=cred_id,
        username=username,
        password=password,
        desc=desc,
        scope=scope,
    )
    client.post_xml(
        f"{_CRED_BASE}/createCredentials",
        xml_str=xml,
        invalidate="credentials.",
    )


def delete_credential(client: CloudBeesClient, cred_id: str) -> None:
    """Delete a credential by ID."""
    client.post(
        f"{_CRED_BASE}/{cred_id}/doDelete",
        invalidate="credentials.",
    )
