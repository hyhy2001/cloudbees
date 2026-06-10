"""User service."""

from __future__ import annotations
from cb.api.client import CloudBeesClient
from cb.dtos.user import UserDTO


def list_users(client: CloudBeesClient) -> list[UserDTO]:
    data = client.get(
        "/asynchPeople/api/json?tree=users[user[id,fullName,description,absoluteUrl]]",
        cache_key="users.list",
    )
    users_raw = (data or {}).get("users", [])
    return [UserDTO.from_dict(u.get("user", {})) for u in users_raw]


def get_user(client: CloudBeesClient, user_id: str) -> UserDTO:
    data = client.get(
        f"/user/{user_id}/api/json",
        cache_key=f"users.detail.{user_id}",
    )
    return UserDTO.from_dict(data or {})
