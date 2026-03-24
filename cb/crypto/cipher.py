"""Fernet symmetric encryption wrapper using cryptography library."""

import os
import base64
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes


PBKDF2_ITERATIONS = 390_000  # OWASP 2023 recommendation


def generate_salt() -> bytes:
    """Generate a 16-byte random salt."""
    return os.urandom(16)


def derive_key(password: str, salt: bytes) -> bytes:
    """Derive a Fernet-compatible key from password + salt via PBKDF2HMAC."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    raw = kdf.derive(password.encode("utf-8"))
    return base64.urlsafe_b64encode(raw)


def encrypt(plaintext: str, password: str, salt: bytes) -> bytes:
    """Encrypt a plaintext string with a password-derived key."""
    key = derive_key(password, salt)
    f = Fernet(key)
    return f.encrypt(plaintext.encode("utf-8"))


def decrypt(ciphertext: bytes, password: str, salt: bytes) -> str:
    """Decrypt a ciphertext blob back to a plaintext string."""
    key = derive_key(password, salt)
    f = Fernet(key)
    return f.decrypt(ciphertext).decode("utf-8")
