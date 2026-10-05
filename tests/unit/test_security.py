import pytest

from naryadai.auth.security import fingerprint, hash_secret, new_token, verify_secret


def test_hashes_are_salted_and_secret_is_verified():
    first = hash_secret("123456")
    second = hash_secret("123456")
    assert first != second
    assert first.startswith("$argon2id$")
    assert verify_secret(first, "123456")
    assert not verify_secret(first, "654321")
    assert not verify_secret(None, "123456")
    assert not verify_secret("broken", "123456")


@pytest.mark.parametrize("secret", ["12345", "x" * 129])
def test_secret_size_limit(secret):
    with pytest.raises(ValueError):
        hash_secret(secret)


def test_tokens_are_unpredictable_and_only_fingerprint_is_stored():
    first, second = new_token(), new_token()
    assert first != second
    assert len(first) == 43
    assert len(fingerprint(first)) == 64
    assert first not in fingerprint(first)
