import test_db_path  # Must precede config/app imports.
import os
import tempfile
from pathlib import Path

assert os.environ['PUUK_DB_PATH'].startswith(tempfile.gettempdir() + os.sep)
assert Path(os.environ['PUUK_DB_PATH']).is_absolute()
import sqlite3
_test_database = Path(os.environ['PUUK_DB_PATH']).resolve()
assert _test_database.is_relative_to(Path(tempfile.gettempdir()).resolve())
os.environ['PUUK_DB_PATH'] = str(_test_database)
_isolation_connection = sqlite3.connect(_test_database)
try:
    assert Path(_isolation_connection.execute('PRAGMA database_list').fetchone()[2]).resolve() == _test_database
finally:
    _isolation_connection.close()

import base64
import hashlib
import subprocess
import pytest
from unittest import mock

with mock.patch('qdrant_client.QdrantClient'):
    from services import delivery_service


def openssl_signing_oracle(path: str, expires: int, secret: str) -> str:
    """Independent oracle invoking standard OpenSSL CLI directly."""
    message = f"{expires}{path} {secret}".encode("utf-8")
    proc = subprocess.run(
        ["openssl", "dgst", "-md5", "-binary"],
        input=message,
        capture_output=True,
        check=True,
    )
    return base64.urlsafe_b64encode(proc.stdout).decode("ascii").rstrip("=")


def hashlib_md5_oracle(path: str, expires: int, secret: str) -> str:
    """Independent oracle invoking Python standard hashlib MD5 directly."""
    message = f"{expires}{path} {secret}".encode("utf-8")
    raw_digest = hashlib.md5(message).digest()
    return base64.urlsafe_b64encode(raw_digest).decode("ascii").rstrip("=")


def test_independent_oracles_match_fixed_j1_vector():
    path = "/cdn/audio/00000000-0000-0000-0000-000000000001/v1"
    expires = 1763251200
    secret = "k7W9xP2mQ5vL8nJ1"
    expected = "NcMUu1kyDzVaG8fx-u-7WQ"

    openssl_result = openssl_signing_oracle(path, expires, secret)
    hashlib_result = hashlib_md5_oracle(path, expires, secret)

    assert openssl_result == expected
    assert hashlib_result == expected
    assert delivery_service.sign_path(path, expires, secret) == expected


@pytest.mark.parametrize("path,expires,secret", [
    ("/cdn/audio/c8c549fe-f6dc-4be1-a4e5-c056bbc47520/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", 1800000000, "SecretKey1234567890"),
    ("/cdn/audio/ffffffff-ffff-4fff-bfff-ffffffffffff/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", 1999999999, "6charK"),
    ("/cdn/audio/12345678-1234-4234-8234-123456789abc/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1700000000, "32_chars_long_secret_key_12345!"),
])
def test_independent_oracles_cross_validation(path, expires, secret):
    openssl_sig = openssl_signing_oracle(path, expires, secret)
    hashlib_sig = hashlib_md5_oracle(path, expires, secret)
    service_sig = delivery_service.sign_path(path, expires, secret)

    assert openssl_sig == hashlib_sig
    assert service_sig == openssl_sig
    assert len(service_sig) == 22
    assert "=" not in service_sig


def test_signing_sensitivity_and_mutation():
    path = "/cdn/audio/11111111-2222-4333-8444-555555555555/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    expires = 1763251200
    secret = "ValidSigningSecret1234567890"

    base_sig = openssl_signing_oracle(path, expires, secret)
    assert delivery_service.sign_path(path, expires, secret) == base_sig

    # 1-bit flip in path
    mutated_path = path[:-1] + ("a" if path[-1] != "a" else "b")
    assert delivery_service.sign_path(mutated_path, expires, secret) != base_sig

    # 1-digit change in expiry
    assert delivery_service.sign_path(path, expires + 1, secret) != base_sig

    # 1-bit change in secret
    mutated_secret = secret[:-1] + ("X" if secret[-1] != "X" else "Y")
    assert delivery_service.sign_path(path, expires, mutated_secret) != base_sig

    # Missing space or extra space
    no_space_msg = f"{expires}{path}{secret}".encode("utf-8")
    assert base64.urlsafe_b64encode(hashlib.md5(no_space_msg).digest()).decode().rstrip("=") != base_sig

    # Uppercase hex vs lowercase hex
    upper_path = path.upper()
    assert delivery_service.sign_path(upper_path, expires, secret) != base_sig

    # Trailing slash
    assert delivery_service.sign_path(path + "/", expires, secret) != base_sig


def test_token_format_invariants():
    path = "/cdn/audio/00000000-0000-4000-8000-000000000001/1111111111111111111111111111111111111111111111111111111111111111"
    expires = 1750000000
    secret = "TestKey123456"

    token = delivery_service.sign_path(path, expires, secret)
    # Token must be exactly 22 URL-safe Base64 chars with no padding
    assert len(token) == 22
    assert "=" not in token
    assert "+" not in token
    assert "/" not in token
    for c in token:
        assert c.isalnum() or c in ("-", "_")
