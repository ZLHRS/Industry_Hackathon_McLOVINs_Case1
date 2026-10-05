from __future__ import annotations

import base64
import os

import pytest
import requests
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid

from naryadai.config import Settings
from naryadai.infrastructure import webpush


def _key_material() -> tuple[str, str]:
    private = ec.generate_private_key(ec.SECP256R1())
    public = private.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    p256dh = base64.urlsafe_b64encode(public).decode().rstrip("=")
    auth = base64.urlsafe_b64encode(os.urandom(16)).decode().rstrip("=")
    return p256dh, auth


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://fcm.googleapis.com/fcm/send/token",
        "https://updates.push.services.mozilla.com/wpush/v2/token",
        "https://web.push.apple.com/QH/token",
        "https://foo.notify.windows.com/wns/token",
    ],
)
def test_known_push_provider_endpoints_are_accepted(endpoint: str) -> None:
    assert webpush.validate_endpoint(endpoint) == endpoint


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/token",
        "https://localhost/token",
        "https://fcm.googleapis.com:444/token",
        "https://user:pass@fcm.googleapis.com/token",
        "https://fcm.googleapis.com/token#fragment",
        "https://fcm.googleapis.com.evil.example/token",
    ],
)
def test_endpoint_validation_rejects_ssrf_and_redirect_targets(endpoint: str) -> None:
    with pytest.raises(ValueError, match="invalid push endpoint"):
        webpush.validate_endpoint(endpoint)


def test_key_validation_requires_real_p256_point_and_16_byte_auth() -> None:
    p256dh, auth = _key_material()
    webpush.validate_keys(p256dh, auth)
    with pytest.raises(ValueError):
        webpush.validate_keys(base64.urlsafe_b64encode(b"x" * 65).decode(), auth)
    with pytest.raises(ValueError):
        webpush.validate_keys(p256dh, base64.urlsafe_b64encode(b"short").decode())


def test_session_disables_redirects_and_environment_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    observed: dict[str, object] = {}

    def fake_request(_self, _method, _url, **kwargs):
        observed.update(kwargs)
        return requests.Response()

    monkeypatch.setattr(requests.Session, "request", fake_request)
    session = webpush._NoRedirectSession()
    session.request("POST", "https://fcm.googleapis.com/fcm/send/token")
    assert session.trust_env is False
    assert observed["allow_redirects"] is False


@pytest.mark.asyncio
async def test_send_encrypts_generic_payload_without_network(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    key_file = tmp_path / "vapid.pem"
    vapid = Vapid()
    vapid.generate_keys()
    key_file.write_bytes(vapid.private_pem())
    captured: dict[str, object] = {}

    def fake_send(_self, request, **_kwargs):
        captured["body"] = request.body
        captured["headers"] = request.headers
        response = requests.Response()
        response.status_code = 201
        response.request = request
        return response

    monkeypatch.setattr(requests.Session, "send", fake_send)
    p256dh, auth = _key_material()
    result = await webpush.send_web_push(
        Settings(
            web_push_private_key_file=key_file, web_push_subject="https://github.com/org/repo"
        ),
        endpoint="https://fcm.googleapis.com/fcm/send/token",
        p256dh=p256dh,
        auth=auth,
        payload=webpush.build_payload("00000000-0000-0000-0000-000000000001", urgent=False),
    )
    assert result.status_code == 201
    assert captured["headers"]["Content-Encoding"] == "aes128gcm"
    assert "Новое служебное уведомление".encode() not in captured["body"]
