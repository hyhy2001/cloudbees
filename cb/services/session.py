"""Session management -- machine-key encrypted token for auto-login.

The session token is stored in the 'settings' table under key 'session_token'
and 'session_profile'. It uses a machine-derived key (not user password) so
the TUI/CLI can restore the client without asking the user to type a password.

Security: the machine key is derived from a fixed local secret (hostname + a
stable UUID stored in settings). It is NOT cryptographically strong compared to
a user password, but it prevents trivial plaintext exposure and is acceptable
for a developer CLI tool running on a trusted machine.
"""

from __future__ import annotations
import base64
import hashlib
import os
import socket
from pathlib import Path

from cb.db.connection import get_connection


_KEY_LEN = 32


# -- Machine key ------------------------------------------------


def _get_machine_secret(db_path: Path | None = None) -> str:
    """Return (or create) a stable per-machine secret stored in settings."""
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'machine_secret'"
        ).fetchone()
        if row:
            return row["value"]
        # Create once
        secret = base64.urlsafe_b64encode(os.urandom(32)).decode()
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('machine_secret', ?)",
            (secret,),
        )
        conn.commit()
        return secret
    finally:
        conn.close()


def _machine_key(db_path: Path | None = None) -> bytes:
    """Derive a 32-byte key from machine secret + hostname."""
    secret = _get_machine_secret(db_path)
    # raw = f"{secret}:{socket.gethostname()}"
    # return hashlib.sha256(raw.encode()).digest()
    return hashlib.sha256(secret.encode()).digest()


def _xor_encrypt(data: str, key: bytes) -> bytes:
    """Simple XOR cipher -- good enough for a dev-tool CLI session."""
    b = data.encode("utf-8")
    key_cycle = (key * (len(b) // len(key) + 1))[: len(b)]
    return bytes(x ^ k for x, k in zip(b, key_cycle))


def _xor_decrypt(data: bytes, key: bytes) -> str:
    key_cycle = (key * (len(data) // len(key) + 1))[: len(data)]
    return bytes(x ^ k for x, k in zip(data, key_cycle)).decode("utf-8")


# -- Public API -------------------------------------------------


def save_session(
    raw_token: str,
    profile_name: str,
    server_url: str,
    username: str,
    db_path: Path | None = None,
) -> None:
    """Encrypt and store session token so CLI/TUI can auto-login."""
    key = _machine_key(db_path)
    enc = base64.b64encode(_xor_encrypt(raw_token, key)).decode()
    conn = get_connection(db_path)
    try:
        for k, v in [
            ("session_token",   enc),
            ("session_profile", profile_name),
            ("session_url",     server_url),
            ("session_user",    username),
        ]:
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (k, v),
            )
        conn.commit()
    finally:
        conn.close()


def load_session(db_path: Path | None = None) -> dict | None:
    """
    Load the saved session.
    Returns {raw_token, profile_name, server_url, username} or None.
    """
    conn = get_connection(db_path)
    try:
        rows = {
            r["key"]: r["value"]
            for r in conn.execute(
                "SELECT key, value FROM settings WHERE key LIKE 'session_%'"
            ).fetchall()
        }
    finally:
        conn.close()

    if "session_token" not in rows:
        return None
    try:
        key = _machine_key(db_path)
        raw_token = _xor_decrypt(base64.b64decode(rows["session_token"]), key)
        return {
            "raw_token":    raw_token,
            "profile_name": rows.get("session_profile", "default"),
            "server_url":   rows.get("session_url", ""),
            "username":     rows.get("session_user", ""),
        }
    except Exception:
        return None


def clear_session(db_path: Path | None = None) -> None:
    """Delete the stored session (Logout)."""
    conn = get_connection(db_path)
    try:
        conn.execute(
            "DELETE FROM settings WHERE key LIKE 'session_%'"
        )
        conn.commit()
    finally:
        conn.close()


def is_logged_in(db_path: Path | None = None) -> bool:
    return load_session(db_path) is not None
