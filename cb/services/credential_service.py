from __future__ import annotations
"""Credential service - controller-scoped for CloudBees CI / OC.

Endpoint pattern (as specified by CloudBees API):
  store="system"  → /credentials/store/system/domain/_
  store="user"    → /user/<username>/credentials/store/user/domain/_

Default is "system" so Jobs and Nodes can use the credentials.
"""

from pathlib import Path
from typing import Optional, List

from cb.api.client import CloudBeesClient
from cb.api.xml_builder import build_username_password_cred_xml
from cb.dtos.credential import CredentialDTO

# Valid store choices — exposed for CLI/TUI validation.
CREDENTIAL_STORES = ("system", "user")


def _get_user_seg(username: str = "", store: str = "system") -> str:
    """Return the REST path segment for the credential store.

    Args:
        username: Logged-in username (needed for user store).
        store:    "system" (default) or "user".
    """
    if store == "user" and username and username.lower() != "system":
        return f"/user/{username}/credentials/store/user/domain/_"
    # Fallback and default: system store — accessible by all jobs/nodes.
    return "/credentials/store/system/domain/_"


def list_credentials(
    client: CloudBeesClient,
    username: str = "",
    store: str = "system",
) -> List[CredentialDTO]:
    user_seg = _get_user_seg(username, store)
    cache_key = f"credentials.list.{client.base_url}.{store}"
    data = client.get(
        f"{user_seg}/api/json?tree=credentials[id,typeName,description,scope,displayName]",
        cache_key=cache_key,
    )
    return [CredentialDTO.from_dict(c) for c in (data or {}).get("credentials", [])]


def get_credential(
    client: CloudBeesClient,
    cred_id: str,
    username: str = "",
    store: str = "system",
) -> CredentialDTO:
    user_seg = _get_user_seg(username, store)
    data = client.get(
        f"{user_seg}/credential/{cred_id}/api/json",
        cache_key=f"credentials.detail.{cred_id}.{store}",
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
    store: str = "system",
) -> None:
    user_seg = _get_user_seg(username, store)
    xml = build_username_password_cred_xml(
        cred_id=cred_id,
        username=username_cred,
        password=password,
        desc=desc,
        scope=scope,
    )
    client.post_xml(
        f"{user_seg}/createCredentials",
        xml_str=xml,
        invalidate="credentials.",
    )


def delete_credential(
    client: CloudBeesClient,
    cred_id: str,
    username: str = "",
    store: str = "system",
) -> None:
    user_seg = _get_user_seg(username, store)
    client.post(
        f"{user_seg}/credential/{cred_id}/doDelete",
        invalidate="credentials.",
    )


def update_credential(
    client: CloudBeesClient,
    cred_id: str,
    xml_str: str,
    username: str = "",
    store: str = "system",
) -> None:
    user_seg = _get_user_seg(username, store)
    client.post_xml(
        f"{user_seg}/credential/{cred_id}/config.xml",
        xml_str=xml_str,
        invalidate="credentials.",
    )
