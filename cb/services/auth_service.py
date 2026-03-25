"""Authentication service — login, logout, profile switching."""

from __future__ import annotations
import os
import time
from pathlib import Path

from cb.db.repositories.profile_repo import (
    save_profile, get_profile, get_default_profile,
    list_profiles, delete_profile,
)
from cb.dtos.auth import ProfileDTO
from cb.api.client import CloudBeesClient
from cb.api.exceptions import AuthError
from cb.db.connection import init_db


def login(
    server_url: str,
    username: str,
    password: str,
    profile_name: str = "default",
    is_default: bool = True,
    db_path: Path | None = None,
) -> ProfileDTO:
    """
    Authenticate against CloudBees, encrypt the token, and store it.
    Returns the created/updated ProfileDTO.
    """
    init_db(db_path)

    # Verify credentials by calling the API
    client = CloudBeesClient(server_url, _build_basic_token(username, password))
    try:
        client.get("/me/api/json?tree=id,fullName")
    except AuthError:
        raise AuthError("Login failed: invalid username or password.")

    # Credentials are valid — store profile and set machine-key session
    profile = save_profile(server_url=server_url, name=profile_name,
                           username=username, is_default=is_default,
                           db_path=db_path)

    from cb.services.session import save_session
    raw_token = _build_basic_token(username, password)
    save_session(raw_token, profile_name, server_url, username, db_path)

    return profile


def logout(profile_name: str | None = None, db_path: Path | None = None) -> None:
    """Remove stored token (and optionally profile) for the given profile."""
    # Machine-key session bypasses profile-specific token deletion now
    from cb.services.session import clear_session
    clear_session(db_path)


def get_client(
    profile_name: str | None = None,
    db_path: Path | None = None,
    use_controller: bool = True,
) -> CloudBeesClient:
    """
    Build an authenticated CloudBeesClient from the session token.
    If use_controller is True, bases the client on the active controller.
    """
    init_db(db_path)

    from cb.services.session import load_session
    session = load_session(db_path)
    if session and session.get("server_url"):
        base_url = session["server_url"]
        
        if use_controller:
            from cb.services.controller_service import get_active_controller
            active = get_active_controller(db_path)
            if active and active[1]:
                # Automatically scope the HTTP requests to the controller's namespace
                base_url = active[1]
                
        return CloudBeesClient(base_url, session["raw_token"], db_path=db_path)

    raise AuthError("Not logged in or session expired. Run: bee login")


def switch_default(profile_name: str, db_path: Path | None = None) -> ProfileDTO:
    """Mark a profile as the default."""
    return save_profile(
        name=profile_name,
        server_url=get_profile(profile_name, db_path).server_url,
        username=get_profile(profile_name, db_path).username,
        is_default=True,
        db_path=db_path,
    )


def _build_basic_token(username: str, password: str) -> str:
    """Build a Basic-auth-compatible token string: 'username:password'."""
    import base64
    raw = f"{username}:{password}"
    return base64.b64encode(raw.encode()).decode()
