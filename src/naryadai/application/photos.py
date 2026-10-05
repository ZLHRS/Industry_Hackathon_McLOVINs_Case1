"""Transactional work-order photo operations."""

from __future__ import annotations

import hashlib
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from anyio import CancelScope, CapacityLimiter, to_thread
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from naryadai.application.common import (
    OperationError,
    check_version,
    get_order,
    idempotent,
    mutation_result,
    record_event,
    remember,
    require_executor,
    require_master_owner,
)
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import WorkOrderStatus
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import Photo, PhotoKind, WorkOrder
from naryadai.infrastructure.photo_store import PhotoStore, PhotoStoreError


def validate_captured_at(captured_at: datetime | None) -> datetime | None:
    """Normalize a client-provided capture time and reject implausible future claims."""
    if captured_at is None:
        return None
    if captured_at.tzinfo is None or captured_at.utcoffset() is None:
        raise OperationError(422, "captured_at_must_be_timezone_aware")
    normalized = captured_at.astimezone(UTC)
    if normalized > datetime.now(UTC) + timedelta(minutes=5):
        raise OperationError(422, "captured_at_too_far_in_future")
    return normalized


async def preflight_upload_authorization(
    database: Database, principal: Principal, order_id: UUID, kind: PhotoKind
) -> None:
    """Reject an actor who can never upload this kind before reading a request body.

    Status and version intentionally remain inside the locked mutation so a valid
    idempotent replay survives a later state transition.
    """
    async with database.sessions() as session:
        order = await get_order(session, order_id, principal)
        _authorize_relationship(order, principal, kind)


async def upload_photo(
    database: Database,
    principal: Principal,
    order_id: UUID,
    *,
    kind: PhotoKind,
    expected_version: int,
    captured_at: datetime | None,
    idempotency_key: str,
    raw: bytes,
    content_type: str,
    photo_store: PhotoStore,
    limiter: CapacityLimiter,
) -> dict[str, Any]:
    """Authorize, normalize, persist, and audit one private photo atomically with metadata."""
    captured_at = validate_captured_at(captured_at)
    payload = {
        "order_id": str(order_id),
        "kind": kind.value,
        "expected_version": expected_version,
        "captured_at": captured_at.isoformat() if captured_at else None,
        "content_type": content_type,
        "content_sha256": hashlib.sha256(raw).hexdigest(),
    }
    operation = "photo_upload"
    created_key: str | None = None

    try:
        async with database.sessions.begin() as session:
            replay = await idempotent(session, principal, idempotency_key, operation, payload)
            if replay is not None:
                return replay

            order = await get_order(session, order_id, principal, lock=True)
            _authorize_upload(order, principal, kind)
            check_version(order, expected_version)
            await _check_limit(session, order_id, kind, order.attempt)

            try:
                stored = await to_thread.run_sync(
                    photo_store.store, raw, content_type, limiter=limiter
                )
            except PhotoStoreError as error:
                raise OperationError(422, str(error)) from None
            created_key = stored.storage_key

            photo = Photo(
                work_order_id=order.id,
                kind=kind,
                attempt=order.attempt,
                storage_key=stored.storage_key,
                captured_at=captured_at,
                author_id=principal.employee_id,
                sha256=stored.sha256,
                size_bytes=stored.size_bytes,
            )
            session.add(photo)
            order.version += 1
            await session.flush()

            response = mutation_result(order) | {
                "photo_id": str(photo.id),
                "kind": kind.value,
                "attempt": photo.attempt,
                "sha256": photo.sha256,
                "size_bytes": photo.size_bytes,
                "content_url": f"/api/v1/work-orders/{order.id}/photos/{photo.id}",
            }
            await record_event(
                session,
                order,
                principal,
                "photo_uploaded",
                order.status,
                details={
                    "photo_id": str(photo.id),
                    "kind": kind.value,
                    "attempt": photo.attempt,
                    "sha256": photo.sha256,
                    "size_bytes": photo.size_bytes,
                },
            )
            await remember(session, principal, idempotency_key, operation, payload, response)
            return response
    except BaseException:
        if created_key is not None:
            with CancelScope(shield=True), suppress(PhotoStoreError, OSError):
                await to_thread.run_sync(photo_store.delete, created_key, limiter=limiter)
        raise


def _authorize_relationship(order: WorkOrder, principal: Principal, kind: PhotoKind) -> None:
    if kind is PhotoKind.BEFORE:
        require_master_owner(order, principal)
    else:
        require_executor(order, principal)


def _authorize_upload(order: WorkOrder, principal: Principal, kind: PhotoKind) -> None:
    _authorize_relationship(order, principal, kind)
    if kind is PhotoKind.BEFORE:
        if order.status is not WorkOrderStatus.ISSUED:
            raise OperationError(409, "before_photos_require_issued_order")
        return
    if order.status not in {WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.PAUSED}:
        raise OperationError(409, "after_photos_require_active_order")


async def _check_limit(
    session: AsyncSession, order_id: UUID, kind: PhotoKind, attempt: int
) -> None:
    statement = (
        select(func.count())
        .select_from(Photo)
        .where(
            Photo.work_order_id == order_id,
            Photo.kind == kind,
        )
    )
    if kind is PhotoKind.AFTER:
        statement = statement.where(Photo.attempt == attempt)
    count = await session.scalar(statement)
    if count is not None and count >= 5:
        raise OperationError(409, "photo_limit_reached")
