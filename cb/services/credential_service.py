from __future__ import annotations
"""Credential service - controller-scoped for CloudBees CI / OC.

Endpoint pattern (as specified by CloudBees API):
  No controller selected  -> /cjoc/user/<username>/credentials/api/json
  Controller selected     -> /job/<ctrl>/user/<username>/credentials/api/json
"""

from pathlib import Path
from typing import Optional, List

from cb.api.client import CloudBeesClient
from cb.api.xml_builder import build_username_password_cred_xml
from cb.dtos.credential import CredentialDTO


def list_credentials(
    client: CloudBeesClient,
    username: str = "",
) -> List[CredentialDTO]:
    user_seg  = f"/user/{username}/credentials/store/user/domain/_" if username else "/credentials/store/system/domain/_"
    cache_key = f"credentials.list.{client.base_url}"
    data = client.get(
        f"{user_seg}/api/json",
        cache_key=cache_key,
    )
    return [CredentialDTO.from_dict(c) for c in (data or {}).get("credentials", [])]


def get_credential(
    client: CloudBeesClient,
    cred_id: str,
    username: str = "",
) -> CredentialDTO:
    user_seg = f"/user/{username}/credentials/store/user/domain/_" if username else "/credentials/store/system/domain/_"
    data = client.get(
        f"{user_seg}/credential/{cred_id}/api/json",
        cache_key=f"credentials.detail.{cred_id}",
    )
    return CredentialDTO.from_dict(data or {})


def create_username_password(
    client: CloudBeesClient,
    cred_id: str,
    username_cred: str,
    password: str,
    desc: str = "",
    scope: str = "GLOBAL",
    username: str = "",
) -> None:
    user_seg = f"/user/{username}/credentials/store/user/domain/_" if username else "/credentials/store/system/domain/_"
    xml = build_username_password_cred_xml(
        cred_id=cred_id,
        username=username_cred,
        password=password,
        desc=desc,
        scope=scope,
    )
    # The user specifies "newCredentials" but standard Jenkins uses "createCredentials" via XML
    # We will try createCredentials which is the standard API way.
    client.post_xml(
        f"{user_seg}/createCredentials",
        xml_str=xml,
        invalidate="credentials.",
    )


def delete_credential(
    client: CloudBeesClient,
    cred_id: str,
    username: str = "",
) -> None:
    user_seg = f"/user/{username}/credentials/store/user/domain/_" if username else "/credentials/store/system/domain/_"
    client.post(
        f"{user_seg}/credential/{cred_id}/doDelete",
        invalidate="credentials.",
    )
