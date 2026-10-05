"""Shared transactional safeguards for work orders and repair evidence."""

import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import and_, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import ActorRole, WorkOrderStatus
from naryadai.infrastructure.models import (
    IdempotencyRecord,
    OutboxEvent,
    WorkOrder,
    WorkOrderEvent,
)


class OperationError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def ensure_role(principal: Principal, *roles: str) -> None:
    if principal.role not in roles:
        raise OperationError(403, "role_not_permitted")


def visible_orders(principal: Principal) -> ColumnElement[bool]:
    ensure_role(principal, "master", "executor", "manager")
    scope: ColumnElement[bool] = WorkOrder.area_id.in_(principal.area_ids)
    if principal.role == "executor":
        scope = and_(scope, WorkOrder.executor_id == principal.employee_id)
    return scope


async def get_order(
    session: AsyncSession, order_id: UUID, principal: Principal, *, lock: bool = False
) -> WorkOrder:
    query = select(WorkOrder).where(WorkOrder.id == order_id, visible_orders(principal))
    if lock:
        query = query.with_for_update()
    order = await session.scalar(query)
    if order is None:
        raise OperationError(404, "order_not_found")
    return order


def require_master_owner(order: WorkOrder, principal: Principal) -> None:
    ensure_role(principal, "master")
    if order.master_id != principal.employee_id:
        raise OperationError(403, "issuing_master_required")


def require_executor(order: WorkOrder, principal: Principal) -> None:
    ensure_role(principal, "executor")
    if order.executor_id != principal.employee_id:
        raise OperationError(404, "order_not_found")


def check_version(order: WorkOrder, expected_version: int) -> None:
    if order.version != expected_version:
        raise OperationError(409, "version_conflict")


def _request_hash(operation: str, payload: dict[str, Any]) -> str:
    canonical = json.dumps(
        {"operation": operation, "payload": payload},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


async def idempotent(
    session: AsyncSession, principal: Principal, key: str, operation: str, payload: dict[str, Any]
) -> dict[str, Any] | None:
    if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", key):
        raise OperationError(422, "invalid_idempotency_key")
    digest = hashlib.sha256(f"idempotency:{principal.employee_id}:{key}".encode()).digest()
    lock_key = int.from_bytes(digest[:8], "big", signed=True)
    await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_key})
    existing = await session.get(IdempotencyRecord, (principal.employee_id, key))
    if existing is None:
        return None
    if existing.request_hash != _request_hash(operation, payload):
        raise OperationError(409, "idempotency_key_conflict")
    # A replay never grants access after reassignment or a scope change.
    await get_order(session, existing.order_id, principal)
    return existing.response


async def remember(
    session: AsyncSession,
    principal: Principal,
    key: str,
    operation: str,
    payload: dict[str, Any],
    response: dict[str, Any],
) -> None:
    session.add(
        IdempotencyRecord(
            actor_id=principal.employee_id,
            key=key,
            request_hash=_request_hash(operation, payload),
            order_id=UUID(response["order_id"]),
            response=response,
        )
    )
    await session.flush()


def mutation_result(order: WorkOrder) -> dict[str, Any]:
    return {"order_id": str(order.id), "version": order.version, "status": order.status.value}


async def record_event(
    session: AsyncSession,
    order: WorkOrder,
    principal: Principal,
    action: str,
    from_status: WorkOrderStatus | None,
    *,
    reason: str | None = None,
    details: dict[str, Any] | None = None,
    at: datetime | None = None,
    system: bool = False,
) -> None:
    """Caller holds the order lock and has already advanced its version."""
    sequence = (
        await session.scalar(
            select(func.max(WorkOrderEvent.sequence)).where(
                WorkOrderEvent.work_order_id == order.id
            )
        )
        or 0
    ) + 1
    occurred_at = at or datetime.now(UTC)
    event_id = uuid4()
    session.add(
        WorkOrderEvent(
            id=event_id,
            work_order_id=order.id,
            sequence=sequence,
            order_version=order.version,
            actor_id=None if system else principal.employee_id,
            actor_role=ActorRole.SYSTEM if system else ActorRole(principal.role),
            action=action,
            from_status=from_status,
            to_status=order.status,
            occurred_at=occurred_at,
            reason=reason,
            details=(details or {}) | {"version": order.version, "attempt": order.attempt},
        )
    )
    # Explicit flush establishes the event FK without relying on ORM relationships.
    await session.flush()
    session.add(
        OutboxEvent(
            work_order_id=order.id,
            event_id=event_id,
            event_type="work_order." + action,
            payload={
                "order_id": str(order.id),
                "event_id": str(event_id),
                "version": order.version,
                "action": action,
            },
            created_at=occurred_at,
        )
    )
    await session.flush()
