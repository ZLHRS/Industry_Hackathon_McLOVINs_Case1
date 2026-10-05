"""Argon2id credentials and non-reversible opaque-session token fingerprints."""

import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_HASHER = PasswordHasher()
_DUMMY_HASH = _HASHER.hash("unused-dummy-credential-for-timing")


def hash_secret(secret: str) -> str:
    if not 6 <= len(secret) <= 128:
        raise ValueError("Secret must contain 6 to 128 characters")
    return _HASHER.hash(secret)


def verify_secret(stored_hash: str | None, candidate: str) -> bool:
    try:
        valid = _HASHER.verify(stored_hash or _DUMMY_HASH, candidate)
    except (VerificationError, InvalidHashError):
        return False
    return bool(valid and stored_hash)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
