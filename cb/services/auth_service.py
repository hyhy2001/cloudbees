"""Authentication service — login, logout, profile switching."""

from __future__ import annotations
import os
import time
from pathlib import Path

from cb.crypto.cipher import encrypt, generate_salt, decrypt
from cb.db.connection import init_db
from cb.db.repositories.profile_repo import (
    save_profile, get_profile, get_default_profile,
    list_profiles, delete_profile,
    save_token, get_token, delete_token,
)
from cb.dtos.auth import ProfileDTO
from cb.api.client import CloudBeesClient
from cb.api.exceptions import AuthError


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

    # Credentials are valid — store profile + encrypted token + session
    profile = save_profile(server_url=server_url, name=profile_name,
                           username=username, is_default=is_default,
                           db_path=db_path)
    salt = generate_salt()
    enc = encrypt(_build_basic_token(username, password), password, salt)
    save_token(profile.id, enc_token=enc, salt=salt, db_path=db_path)

    # Save machine-key session (auto-login, no password needed next time)
    from cb.services.session import save_session
    raw_token = _build_basic_token(username, password)
    save_session(raw_token, profile_name, server_url, username, db_path)

    return profile


def logout(profile_name: str | None = None, db_path: Path | None = None) -> None:
    """Remove stored token (and optionally profile) for the given profile."""
    profile = (
        get_profile(profile_name, db_path)
        if profile_name
        else get_default_profile(db_path)
    )
    if profile is None:
        return
    delete_token(profile.id, db_path)


def get_client(
    profile_name: str | None = None,
    password: str | None = None,
    db_path: Path | None = None,
) -> CloudBeesClient:
    """
    Build an authenticated CloudBeesClient.
    Priority: session token (auto-login) → password decrypt → error.
    """
    init_db(db_path)

    # 1. Try session token (machine-key encrypted, no password needed)
    from cb.services.session import load_session
    session = load_session(db_path)
    if session and session.get("server_url"):
        return CloudBeesClient(session["server_url"], session["raw_token"], db_path=db_path)

    # 2. Fall back to password-encrypted token in DB
    profile = (
        get_profile(profile_name, db_path)
        if profile_name
        else get_default_profile(db_path)
    )
    if profile is None:
        raise AuthError("No profile found. Run: bee login")

    token_dto = get_token(profile.id, db_path)
    if token_dto is None:
        raise AuthError(f"No token for profile '{profile.name}'. Run: bee login")

    pwd = password or os.environ.get("CB_PASSWORD")
    if not pwd:
        raise AuthError("Not logged in. Run: bee login")

    raw_token = decrypt(token_dto.enc_token, pwd, token_dto.salt)
    return CloudBeesClient(profile.server_url, raw_token, db_path=db_path)


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
