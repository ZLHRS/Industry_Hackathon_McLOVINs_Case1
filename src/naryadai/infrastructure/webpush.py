"""Strict, bounded Web Push transport primitives."""

from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import requests
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid  # type: ignore[import-untyped]
from pywebpush import WebPushException, webpush  # type: ignore[import-untyped]

if TYPE_CHECKING:
    from naryadai.config import Settings

_MAX_TIMEOUT_SECONDS = 30.0
_MAX_RETRY_AFTER_SECONDS = 3_600


@dataclass(frozen=True, slots=True)
class PushResult:
    status_code: int | None
    retry_after_seconds: int | None
    error_kind: str | None


class _NoRedirectSession(requests.Session):
    def __init__(self) -> None:
        super().__init__()
        self.trust_env = False

    def request(  # type: ignore[override]
        self, method: str, url: str, **kwargs: Any
    ) -> requests.Response:
        kwargs["allow_redirects"] = False
        return super().request(method, url, **kwargs)


def validate_endpoint(endpoint: str) -> str:
    """Allow only HTTPS endpoints of known Web Push providers."""
    if not isinstance(endpoint, str) or not endpoint or endpoint != endpoint.strip():
        raise ValueError("invalid push endpoint")
    if any(char.isspace() for char in endpoint):
        raise ValueError("invalid push endpoint")
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except ValueError as error:
        raise ValueError("invalid push endpoint") from error
    host = parsed.hostname.lower() if parsed.hostname else None
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.fragment
        or not _trusted_provider(host)
    ):
        raise ValueError("invalid push endpoint")
    return endpoint


def validate_keys(p256dh: str, auth: str) -> None:
    """Validate browser Web Push key material before storing or using it."""
    receiver_key = _decode_base64url(p256dh, "p256dh")
    auth_secret = _decode_base64url(auth, "auth")
    if len(receiver_key) != 65 or receiver_key[0] != 0x04:
        raise ValueError("invalid p256dh key")
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), receiver_key)
    except ValueError as error:
        raise ValueError("invalid p256dh key") from error
    if len(auth_secret) != 16:
        raise ValueError("invalid auth key")


def push_enabled(settings: Settings) -> bool:
    return bool(settings.web_push_private_key_file and settings.web_push_subject)


def public_key(settings: Settings) -> str | None:
    key_file = settings.web_push_private_key_file
    if key_file is None:
        return None
    path = Path(key_file)
    if not path.is_file():
        raise ValueError("configured Web Push private key file is unavailable")
    try:
        vapid = Vapid.from_file(private_key_file=str(path))
        raw = vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        return _base64url(raw)
    except Exception as error:
        raise ValueError("configured Web Push private key is invalid") from error


def build_payload(notification_id: str, *, urgent: bool) -> dict[str, object]:
    return {
        "notification_id": notification_id,
        "title": "Аварийный наряд" if urgent else "ТехНаряд",
        "body": "Новое служебное уведомление. Откройте приложение.",
        "urgent": urgent,
        "url": f"/?notification={notification_id}",
        "tag": notification_id,
    }


async def send_web_push(
    settings: Settings,
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: dict[str, object],
) -> PushResult:
    """Encrypt and send one notification off the event loop.

    Provider acceptance is not proof that the operating system displayed it.
    """
    validate_endpoint(endpoint)
    validate_keys(p256dh, auth)
    if not push_enabled(settings):
        return PushResult(None, None, "push_disabled")
    key_file = settings.web_push_private_key_file
    subject = settings.web_push_subject
    assert key_file is not None and subject is not None
    timeout = min(max(float(settings.push_timeout_seconds), 1.0), _MAX_TIMEOUT_SECONDS)
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return await asyncio.to_thread(
        _send_sync, endpoint, p256dh, auth, serialized, str(key_file), subject, timeout
    )


def _send_sync(
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: str,
    key_file: str,
    subject: str,
    timeout: float,
) -> PushResult:
    session = _NoRedirectSession()
    try:
        # py-vapid 1.x rejects an HTTPS contact path despite RFC VAPID allowing
        # a URI. The configured subject is validated separately by Settings.
        vapid = Vapid.from_file(private_key_file=key_file)
        vapid.conf["no-strict"] = True
        response = webpush(
            {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
            data=payload,
            vapid_private_key=vapid,
            vapid_claims={"sub": subject},
            timeout=timeout,
            ttl=60,
            requests_session=session,
        )
        if isinstance(response, requests.Response):
            return PushResult(response.status_code, _retry_after(response), None)
        return PushResult(None, None, "push_protocol_error")
    except WebPushException as error:
        response = error.response
        if response is not None:
            return PushResult(response.status_code, _retry_after(response), "push_http_error")
        return PushResult(None, None, "push_protocol_error")
    except requests.RequestException:
        return PushResult(None, None, "push_network_error")
    except Exception:
        # Some library exceptions include secret material. Never expose them.
        return PushResult(None, None, "push_transport_error")
    finally:
        session.close()


def _trusted_provider(host: str) -> bool:
    return host in {
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
    } or host.endswith(".notify.windows.com")


def _decode_base64url(value: str, label: str) -> bytes:
    if not isinstance(value, str) or not value or any(char.isspace() for char in value):
        raise ValueError(f"invalid {label} key")
    unpadded = value.rstrip("=")
    if not unpadded or "=" in unpadded or len(unpadded) % 4 == 1:
        raise ValueError(f"invalid {label} key")
    try:
        decoded = base64.b64decode(
            unpadded + "=" * (-len(unpadded) % 4), altchars=b"-_", validate=True
        )
    except (ValueError, UnicodeEncodeError) as error:
        raise ValueError(f"invalid {label} key") from error
    if _base64url(decoded) != unpadded:
        raise ValueError(f"invalid {label} key")
    return decoded


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _retry_after(response: requests.Response) -> int | None:
    raw = response.headers.get("Retry-After")
    if raw is None:
        return None
    try:
        seconds = int(raw)
    except ValueError:
        try:
            target = parsedate_to_datetime(raw)
        except (TypeError, ValueError, IndexError, OverflowError):
            return None
        if target.tzinfo is None:
            return None
        seconds = int((target.astimezone(UTC) - datetime.now(UTC)).total_seconds())
    return min(max(seconds, 0), _MAX_RETRY_AFTER_SECONDS)
