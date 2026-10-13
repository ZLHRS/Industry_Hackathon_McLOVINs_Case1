"""Private inbox, explicit receipt acknowledgement and session-bound Web Push."""

import hashlib
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import exists, func, or_, select, text
from sqlalchemy.dialects.postgresql import insert

from naryadai.application.common import OperationError, ensure_role, visible_orders
from naryadai.auth.dependencies import DatabaseDep, Principal, PrincipalDep
from naryadai.config import Settings
from naryadai.infrastructure.models import (
    Employee,
    EmployeeArea,
    FaultReport,
    Notification,
    PushSubscription,
    RealtimeRevision,
    WorkOrder,
)
from naryadai.infrastructure.webpush import (
    public_key,
    push_enabled,
    validate_endpoint,
    validate_keys,
)

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    order_id: UUID | None = Field(validation_alias="work_order_id")
    fault_report_id: UUID | None
    kind: str
    title: str
    body: str
    urgent: bool
    action_required: bool
    created_at: datetime
    read_at: datetime | None
    acknowledged_at: datetime | None
    payload: dict[str, Any]


class NotificationPage(BaseModel):
    items: list[NotificationView]
    total: int
    unread_count: int


def notification_view(
    notification: Notification,
    *,
    order_number: str | None = None,
    order_description: str | None = None,
) -> NotificationView:
    """Add a label only for the order joined through the recipient's visibility scope."""

    view = NotificationView.model_validate(notification)
    if notification.work_order_id is None or order_description is None:
        return view
    return view.model_copy(
        update={
            "payload": view.payload
            | {
                "order_number": order_number,
                "order_description": order_description,
            }
        }
    )


def inbox_scope(principal: Principal) -> Any:
    report_live = exists(
        select(Employee.id)
        .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
        .where(
            Employee.id == principal.employee_id,
            Employee.is_active.is_(True),
            Employee.role == principal.role,
            EmployeeArea.area_id == FaultReport.area_id,
        )
        .correlate(FaultReport)
    )
    report_scope: Any
    if principal.role == "executor":
        report_scope = (FaultReport.reporter_id == principal.employee_id) & report_live
    elif principal.role == "master":
        report_scope = (
            (FaultReport.master_id == principal.employee_id)
            & FaultReport.area_id.in_(principal.area_ids)
            & report_live
        )
    else:
        report_scope = FaultReport.id.is_(None)
    return (Notification.employee_id == principal.employee_id) & or_(
        (Notification.work_order_id.is_not(None)) & visible_orders(principal),
        Notification.fault_report_id.in_(select(FaultReport.id).where(report_scope)),
    )


@router.get("", response_model=NotificationPage)
async def inbox(
    database: DatabaseDep,
    principal: PrincipalDep,
    offset: int = Query(default=0, ge=0, le=100_000),
    limit: int = Query(default=50, ge=1, le=100),
    unread_only: bool = False,
) -> NotificationPage:
    scope = inbox_scope(principal)
    async with database.sessions() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
        query = (
            select(Notification, WorkOrder.number, WorkOrder.description)
            .outerjoin(WorkOrder, WorkOrder.id == Notification.work_order_id)
            .where(scope)
        )
        if unread_only:
            query = query.where(Notification.read_at.is_(None))
        total = await session.scalar(select(func.count()).select_from(query.subquery())) or 0
        unread = (
            await session.scalar(
                select(func.count())
                .select_from(Notification)
                .outerjoin(WorkOrder, WorkOrder.id == Notification.work_order_id)
                .where(scope, Notification.read_at.is_(None))
            )
            or 0
        )
        rows = (
            await session.execute(
                query.order_by(Notification.created_at.desc(), Notification.id.desc())
                .offset(offset)
                .limit(limit)
            )
        ).all()
        return NotificationPage(
            items=[
                notification_view(item, order_number=number, order_description=description)
                for item, number, description in rows
            ],
            total=total,
            unread_count=unread,
        )


async def _mark(
    database: DatabaseDep, principal: Principal, notification_id: UUID, *, acknowledge: bool
) -> NotificationView:
    now = datetime.now(UTC)
    async with database.sessions.begin() as session:
        notification = await session.scalar(
            select(Notification)
            .outerjoin(WorkOrder, WorkOrder.id == Notification.work_order_id)
            .where(Notification.id == notification_id, inbox_scope(principal))
            .with_for_update(of=Notification)
        )
        if notification is None:
            raise OperationError(404, "notification_not_found")
        changed = notification.read_at is None or (
            acknowledge and notification.acknowledged_at is None
        )
        notification.read_at = notification.read_at or now
        if acknowledge:
            notification.acknowledged_at = notification.acknowledged_at or now
        if changed:
            statement = insert(RealtimeRevision).values(
                employee_id=principal.employee_id, revision=1, updated_at=now
            )
            await session.execute(
                statement.on_conflict_do_update(
                    index_elements=[RealtimeRevision.employee_id],
                    set_={"revision": RealtimeRevision.revision + 1, "updated_at": now},
                )
            )
        await session.flush()
        order = (
            await session.get(WorkOrder, notification.work_order_id)
            if notification.work_order_id is not None
            else None
        )
        return notification_view(
            notification,
            order_number=None if order is None else order.number,
            order_description=None if order is None else order.description,
        )


@router.post("/{notification_id}/read", response_model=NotificationView)
async def read_notification(
    notification_id: UUID, database: DatabaseDep, principal: PrincipalDep
) -> NotificationView:
    return await _mark(database, principal, notification_id, acknowledge=False)


@router.post("/{notification_id}/ack", response_model=NotificationView)
async def acknowledge_notification(
    notification_id: UUID, database: DatabaseDep, principal: PrincipalDep
) -> NotificationView:
    # Receipt is not acceptance of a work order; lifecycle changes use /actions.
    return await _mark(database, principal, notification_id, acknowledge=True)


class PushConfig(BaseModel):
    enabled: bool
    public_key: str | None


@router.get("/push-config", response_model=PushConfig)
async def push_configuration(request: Request, principal: PrincipalDep) -> PushConfig:
    ensure_role(principal, "master", "executor", "manager")
    settings: Settings = request.app.state.settings
    enabled = push_enabled(settings)
    return PushConfig(enabled=enabled, public_key=public_key(settings) if enabled else None)


class SubscriptionKeys(BaseModel):
    model_config = ConfigDict(extra="forbid")
    p256dh: str = Field(min_length=80, max_length=100)
    auth: str = Field(min_length=20, max_length=32)


class SubscriptionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint: str = Field(min_length=10, max_length=2048)
    keys: SubscriptionKeys


class SubscriptionView(BaseModel):
    id: UUID


@router.post("/subscriptions", response_model=SubscriptionView, status_code=201)
async def subscribe(
    body: SubscriptionInput, request: Request, database: DatabaseDep, principal: PrincipalDep
) -> SubscriptionView:
    ensure_role(principal, "master", "executor", "manager")
    if not push_enabled(request.app.state.settings):
        raise OperationError(503, "push_not_configured")
    try:
        endpoint = validate_endpoint(body.endpoint)
        validate_keys(body.keys.p256dh, body.keys.auth)
    except ValueError:
        raise OperationError(422, "invalid_push_subscription") from None
    digest = hashlib.sha256(endpoint.encode()).hexdigest()
    advisory_key = int.from_bytes(
        hashlib.sha256(("push:" + digest).encode()).digest()[:8], "big", signed=True
    )
    now = datetime.now(UTC)
    async with database.sessions.begin() as session:
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": advisory_key})
        await session.scalar(
            select(Employee.id).where(Employee.id == principal.employee_id).with_for_update()
        )
        subscription = await session.scalar(
            select(PushSubscription)
            .where(PushSubscription.endpoint_hash == digest)
            .with_for_update()
        )
        if (
            subscription is None
            or subscription.employee_id != principal.employee_id
            or subscription.disabled_at
        ):
            count = (
                await session.scalar(
                    select(func.count())
                    .select_from(PushSubscription)
                    .where(
                        PushSubscription.employee_id == principal.employee_id,
                        PushSubscription.disabled_at.is_(None),
                    )
                )
                or 0
            )
            if count >= 10:
                raise OperationError(409, "push_device_limit")
        if subscription is None:
            subscription = PushSubscription(endpoint_hash=digest, endpoint=endpoint, created_at=now)
            session.add(subscription)
        subscription.employee_id = principal.employee_id
        subscription.session_id = principal.session_id
        subscription.p256dh = body.keys.p256dh
        subscription.auth = body.keys.auth
        subscription.disabled_at = None
        await session.flush()
        return SubscriptionView(id=subscription.id)


@router.delete("/subscriptions/{subscription_id}", status_code=204)
async def unsubscribe(
    subscription_id: UUID, database: DatabaseDep, principal: PrincipalDep
) -> Response:
    ensure_role(principal, "master", "executor", "manager")
    async with database.sessions.begin() as session:
        subscription = await session.scalar(
            select(PushSubscription)
            .where(
                PushSubscription.id == subscription_id,
                PushSubscription.employee_id == principal.employee_id,
                PushSubscription.session_id == principal.session_id,
            )
            .with_for_update()
        )
        if subscription is None:
            raise OperationError(404, "subscription_not_found")
        subscription.disabled_at = subscription.disabled_at or datetime.now(UTC)
    return Response(status_code=204)


@router.get("/{notification_id}", response_model=NotificationView)
async def get_notification(
    notification_id: UUID, database: DatabaseDep, principal: PrincipalDep
) -> NotificationView:
    async with database.sessions() as session:
        row = (
            await session.execute(
                select(Notification, WorkOrder.number, WorkOrder.description)
                .outerjoin(WorkOrder, WorkOrder.id == Notification.work_order_id)
                .where(Notification.id == notification_id, inbox_scope(principal))
            )
        ).one_or_none()
        if row is None:
            raise OperationError(404, "notification_not_found")
        item, number, description = row
        return notification_view(item, order_number=number, order_description=description)
