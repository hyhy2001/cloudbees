"""Tests for the crypto module."""

import pytest
from cb.crypto.cipher import generate_salt, encrypt, decrypt


def test_round_trip():
    salt = generate_salt()
    password = "super-secret-password"
    token = "my-api-token-12345"

    encrypted = encrypt(token, password, salt)
    assert isinstance(encrypted, bytes)
    assert token.encode() not in encrypted  # must not be plaintext

    decrypted = decrypt(encrypted, password, salt)
    assert decrypted == token


def test_wrong_password_raises():
    from cryptography.fernet import InvalidToken
    salt = generate_salt()
    encrypted = encrypt("token", "correct-pass", salt)
    with pytest.raises(Exception):
        decrypt(encrypted, "wrong-pass", salt)


def test_salt_uniqueness():
    s1 = generate_salt()
    s2 = generate_salt()
    assert s1 != s2
