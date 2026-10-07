"""Private work-order photo upload and download endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated
from uuid import UUID

from anyio import CapacityLimiter, to_thread
from fastapi import APIRouter, Header, Query, Request, Response
from pydantic import BaseModel, ConfigDict

from naryadai.application.common import OperationError, get_order
from naryadai.application.photos import preflight_upload_authorization, upload_photo
from naryadai.auth.dependencies import DatabaseDep, PrincipalDep
from naryadai.domain.lifecycle import WorkOrderStatus
from naryadai.infrastructure.models import Photo, PhotoKind
from naryadai.infrastructure.photo_store import PhotoStore, PhotoStoreError

router = APIRouter(tags=["work-orders"])
IdempotencyKey = Annotated[
    str,
    Header(alias="Idempotency-Key", min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$"),
]
PhotoKindQuery = Annotated[PhotoKind, Query()]
ExpectedVersion = Annotated[int, Query(ge=1)]
CapturedAt = Annotated[datetime | None, Query()]
_ALLOWED_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})


class PhotoMutationView(BaseModel):
    model_config = ConfigDict(frozen=True)

    order_id: UUID
    version: int
    status: WorkOrderStatus
    photo_id: UUID
    kind: PhotoKind
    attempt: int
    sha256: str
    size_bytes: int
    ai_share_allowed: bool
    content_url: str


@router.post(
    "/work-orders/{order_id}/photos",
    response_model=PhotoMutationView,
    status_code=201,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "image/jpeg": {"schema": {"type": "string", "format": "binary"}},
                "image/png": {"schema": {"type": "string", "format": "binary"}},
                "image/webp": {"schema": {"type": "string", "format": "binary"}},
            },
        }
    },
)
async def create_photo(
    order_id: UUID,
    request: Request,
    principal: PrincipalDep,
    database: DatabaseDep,
    idempotency_key: IdempotencyKey,
    kind: PhotoKindQuery,
    expected_version: ExpectedVersion,
    captured_at: CapturedAt = None,
    ai_share_allowed: bool = False,
) -> PhotoMutationView:
    content_type = _upload_content_type(request)
    await preflight_upload_authorization(database, principal, order_id, kind)
    raw = await _read_bounded_upload(request)
    result = await upload_photo(
        database,
        principal,
        order_id,
        kind=kind,
        expected_version=expected_version,
        captured_at=captured_at,
        ai_share_allowed=ai_share_allowed,
        idempotency_key=idempotency_key,
        raw=raw,
        content_type=content_type,
        photo_store=_photo_store(request),
        limiter=_photo_limiter(request),
    )
    return PhotoMutationView.model_validate(result)


@router.get(
    "/work-orders/{order_id}/photos/{photo_id}",
    response_class=Response,
    responses={200: {"content": {"image/jpeg": {}}}},
)
async def read_photo(
    order_id: UUID,
    photo_id: UUID,
    request: Request,
    principal: PrincipalDep,
    database: DatabaseDep,
) -> Response:
    async with database.sessions() as session:
        await get_order(session, order_id, principal)
        photo = await session.get(Photo, photo_id)
        if photo is None or photo.work_order_id != order_id:
            raise OperationError(404, "photo_not_found")
        storage_key = photo.storage_key
    try:
        content = await to_thread.run_sync(
            _photo_store(request).read, storage_key, limiter=_photo_limiter(request)
        )
    except PhotoStoreError:
        raise OperationError(404, "photo_not_found") from None
    return Response(
        content=content,
        media_type="image/jpeg",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"},
    )


def _upload_content_type(request: Request) -> str:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in _ALLOWED_MIME_TYPES:
        raise OperationError(415, "unsupported_media_type")
    return content_type


async def _read_bounded_upload(request: Request) -> bytes:
    maximum = request.app.state.settings.photo_max_bytes
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > maximum:
                raise OperationError(413, "image_too_large")
        except ValueError:
            raise OperationError(422, "invalid_content_length") from None
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > maximum:
            raise OperationError(413, "image_too_large")
        body.extend(chunk)
    if not body:
        raise OperationError(422, "empty_image")
    return bytes(body)


def _photo_store(request: Request) -> PhotoStore:
    store = getattr(request.app.state, "photo_store", None)
    if not isinstance(store, PhotoStore):
        raise OperationError(503, "photo_storage_unavailable")
    return store


def _photo_limiter(request: Request) -> CapacityLimiter:
    limiter = getattr(request.app.state, "photo_limiter", None)
    if not isinstance(limiter, CapacityLimiter):
        raise OperationError(503, "photo_storage_unavailable")
    return limiter
