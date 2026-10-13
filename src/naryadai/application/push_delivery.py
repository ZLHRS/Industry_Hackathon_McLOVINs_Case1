"""Database-backed, bounded at-least-once Web Push delivery."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import and_, exists, or_, select, update
from sqlalchemy.orm import aliased

from naryadai.config import Settings
from naryadai.domain.lifecycle import WorkOrderStatus
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    Area,
    AuthSession,
    Employee,
    EmployeeArea,
    FaultReport,
    Notification,
    PushDelivery,
    PushSubscription,
    WorkOrder,
    WorkOrderEvent,
    WorkOrderParticipant,
)
from naryadai.infrastructure.webpush import PushResult, build_payload, push_enabled, send_web_push

_MAX_BATCH = 100
_MAX_CONCURRENCY = 4
_MAX_RETRY_AFTER_SECONDS = 3_600
_REMINDER_KINDS = frozenset(
    {"deadline_reminder", "overdue", "manager_overdue", "acceptance_escalation"}
)
_ACTIVE_REMINDER_STATUSES = frozenset(
    {
        WorkOrderStatus.ISSUED,
        WorkOrderStatus.ACCEPTED,
        WorkOrderStatus.QUEUED,
        WorkOrderStatus.IN_PROGRESS,
        WorkOrderStatus.PAUSED,
        WorkOrderStatus.REWORK,
    }
)
_STALE_REMINDER_AGE = timedelta(hours=2)


def _device_body(kind: str, body: str) -> str:
    """Keep full inbox context while reserving compact copy for a lock screen."""

    concise = {
        "acceptance_escalation": (
            "Исполнитель не подтвердил наряд. Откройте карточку: есть рекомендация по замене."
        ),
        "overdue": "Срок истёк. Откройте наряд и обновите статус работ.",
        "manager_overdue": "Просрочка вышла на эскалацию. Проверьте ход работ в наряде.",
        "fault_report_dismissed": "Сообщение отклонено. Причина указана в карточке сообщения.",
    }
    return concise.get(kind, body)


def _device_copy(target: _Target) -> tuple[str, str]:
    """Use the current authorized order label, never mutable notification payload."""

    body = _device_body(target.kind, target.body)
    if target.work_order_id is None or not target.order_description:
        return target.title, body
    context = target.title.strip()
    if target.order_number and target.order_number not in context:
        context = f"{context} · № {target.order_number}"
    return target.order_description, f"{context}. {body}"


@dataclass(frozen=True, slots=True)
class _Claim:
    delivery_id: UUID
    lease_token: UUID
    attempts: int


@dataclass(frozen=True, slots=True)
class _Target:
    subscription_id: UUID
    notification_id: UUID
    employee_id: UUID
    work_order_id: UUID | None
    dedup_key: str
    created_at: datetime
    read_at: datetime | None
    acknowledged_at: datetime | None
    endpoint: str
    p256dh: str
    auth: str
    title: str
    body: str
    kind: str
    urgent: bool
    order_status: WorkOrderStatus | None
    order_issued_at: datetime | None
    order_deadline: datetime | None
    order_attempt: int | None
    order_number: str | None
    order_description: str | None


async def deliver_push(
    database: Database, *, settings: Settings, now: datetime, limit: int = 20
) -> int:
    """Deliver due rows with leases and no database transaction during HTTP.

    Provider acceptance is at-least-once: a crash after remote acceptance and
    before the conditional completion update can cause one later resend.
    """
    if not push_enabled(settings):
        return 0
    claims = await _claim(
        database,
        now,
        min(max(limit, 1), _MAX_BATCH, _MAX_CONCURRENCY),
        settings.push_max_attempts,
        settings.push_lease_seconds,
    )
    semaphore = asyncio.Semaphore(_MAX_CONCURRENCY)

    async def run(claim: _Claim) -> int:
        async with semaphore:
            return await _deliver_claim(database, settings, now, claim)

    outcomes = await asyncio.gather(*(run(claim) for claim in claims))
    return sum(outcomes)


async def _claim(
    database: Database, now: datetime, limit: int, max_attempts: int, lease_seconds: int
) -> list[_Claim]:
    pending = and_(PushDelivery.sent_at.is_(None), PushDelivery.failed_at.is_(None))
    due = and_(
        PushDelivery.next_attempt_at <= now,
        or_(PushDelivery.lease_until.is_(None), PushDelivery.lease_until <= now),
    )
    claims: list[_Claim] = []
    async with database.sessions() as session, session.begin():
        # A process can die after incrementing attempts. Never strand these rows.
        await session.execute(
            update(PushDelivery)
            .where(pending, due, PushDelivery.attempts >= max_attempts)
            .values(
                failed_at=now,
                lease_until=None,
                lease_token=None,
                last_error="push_attempts_exhausted",
            )
        )
        rows = list(
            (
                await session.scalars(
                    select(PushDelivery)
                    .where(pending, due, PushDelivery.attempts < max_attempts)
                    .order_by(PushDelivery.next_attempt_at, PushDelivery.id)
                    .limit(limit)
                    .with_for_update(skip_locked=True)
                )
            ).all()
        )
        lease_until = now + timedelta(seconds=min(max(lease_seconds, 1), 300))
        for row in rows:
            token = uuid4()
            row.lease_token = token
            row.lease_until = lease_until
            row.attempts += 1
            claims.append(_Claim(row.id, token, row.attempts))
    return claims


async def _deliver_claim(
    database: Database, settings: Settings, now: datetime, claim: _Claim
) -> int:
    target = await _target(database, now, claim)
    if target is None:
        await _finish(database, claim, now, error="push_recipient_ineligible")
        return 0
    suppression = await _suppression_reason(database, target, now)
    if suppression is not None:
        await _finish(database, claim, now, error=suppression)
        return 0
    title, body = _device_copy(target)
    try:
        outcome = await send_web_push(
            settings,
            endpoint=target.endpoint,
            p256dh=target.p256dh,
            auth=target.auth,
            payload=build_payload(
                str(target.notification_id),
                title=title,
                body=body,
                urgent=target.urgent,
            ),
        )
    except ValueError:
        outcome = PushResult(None, None, "push_invalid_subscription")
    if outcome.status_code is not None and 200 <= outcome.status_code < 300:
        await _finish(database, claim, now, sent=True)
        return 1
    if outcome.status_code in {404, 410}:
        await _finish(
            database,
            claim,
            now,
            error="push_subscription_gone",
            disable=target.subscription_id,
        )
    elif (
        outcome.status_code == 429
        or (outcome.status_code is not None and outcome.status_code >= 500)
        or (outcome.status_code is None and outcome.error_kind == "push_network_error")
    ):
        await _retry_or_fail(database, claim, now, settings.push_max_attempts, outcome)
    else:
        await _finish(database, claim, now, error=outcome.error_kind or "push_http_error")
    return 0


async def _suppression_reason(database: Database, target: _Target, now: datetime) -> str | None:
    """Prevent a delayed reminder from resurfacing after its context changed.

    Notifications remain in the private inbox for auditability.  This check
    only stops a stale device push immediately before the external transport.
    """

    if target.kind not in _REMINDER_KINDS:
        return None
    if target.read_at is not None or target.acknowledged_at is not None:
        return "push_notification_seen"
    if (
        target.work_order_id is None
        or target.order_status is None
        or target.order_issued_at is None
        or target.order_deadline is None
        or target.order_attempt is None
    ):
        return "push_notification_stale"
    expected_prefix = (
        f"{target.kind}:{target.work_order_id}:{target.order_attempt}:"
        f"{target.order_deadline.isoformat()}:"
    )
    if not target.dedup_key.startswith(expected_prefix):
        return "push_notification_stale"
    if target.created_at < now - _STALE_REMINDER_AGE:
        return "push_notification_stale"
    if target.kind == "deadline_reminder":
        if target.order_status not in _ACTIVE_REMINDER_STATUSES or now >= target.order_deadline:
            return "push_notification_stale"
    elif target.kind in {"overdue", "manager_overdue"}:
        if target.order_status not in _ACTIVE_REMINDER_STATUSES or now < target.order_deadline:
            return "push_notification_stale"
    elif target.kind == "acceptance_escalation":
        if target.order_status is not WorkOrderStatus.ISSUED:
            return "push_notification_stale"
        basis_statement = (
            select(WorkOrderEvent.occurred_at)
            .where(
                WorkOrderEvent.work_order_id == target.work_order_id,
                WorkOrderEvent.action == "reassign",
            )
            .order_by(WorkOrderEvent.sequence.desc())
            .limit(1)
        )
        async with database.sessions() as session:
            basis = await session.scalar(basis_statement)
        basis = basis or target.order_issued_at
        if target.dedup_key != expected_prefix + f"basis:{basis.isoformat()}":
            return "push_notification_stale"

    newer = aliased(Notification)
    statement = (
        select(newer.id)
        .where(
            newer.employee_id == target.employee_id,
            newer.work_order_id == target.work_order_id,
            newer.kind == target.kind,
            newer.created_at > target.created_at,
        )
        .limit(1)
    )
    async with database.sessions() as session:
        if await session.scalar(statement) is not None:
            return "push_notification_superseded"
    return None


async def _target(database: Database, now: datetime, claim: _Claim) -> _Target | None:
    """Recheck all mutable authorization facts immediately before sending."""
    order_area_scope = exists(
        select(EmployeeArea.employee_id)
        .join(Area, Area.id == EmployeeArea.area_id)
        .where(
            EmployeeArea.employee_id == Notification.employee_id,
            EmployeeArea.area_id == WorkOrder.area_id,
            Area.is_active.is_(True),
        )
        .correlate(WorkOrder, Notification)
    )
    report_area_scope = exists(
        select(EmployeeArea.employee_id)
        .join(Area, Area.id == EmployeeArea.area_id)
        .where(
            EmployeeArea.employee_id == Notification.employee_id,
            EmployeeArea.area_id == FaultReport.area_id,
            Area.is_active.is_(True),
        )
        .correlate(FaultReport, Notification)
    )
    order_recipient = and_(
        Notification.work_order_id.is_not(None),
        order_area_scope,
        or_(
            and_(
                Employee.role == "executor",
                or_(
                    WorkOrder.executor_id == Notification.employee_id,
                    exists(
                        select(WorkOrderParticipant.work_order_id)
                        .where(
                            WorkOrderParticipant.work_order_id == WorkOrder.id,
                            WorkOrderParticipant.employee_id == Notification.employee_id,
                        )
                        .correlate(WorkOrder, Notification)
                    ),
                ),
            ),
            Employee.role.in_(("master", "manager")),
        ),
    )
    report_recipient = and_(
        Notification.fault_report_id.is_not(None),
        report_area_scope,
        or_(
            and_(
                Employee.role == "executor",
                FaultReport.reporter_id == Notification.employee_id,
            ),
            and_(
                Employee.role == "master",
                FaultReport.master_id == Notification.employee_id,
            ),
        ),
    )
    statement = (
        select(
            PushSubscription.id,
            Notification.id,
            Notification.employee_id,
            Notification.work_order_id,
            Notification.dedup_key,
            Notification.created_at,
            Notification.read_at,
            Notification.acknowledged_at,
            PushSubscription.endpoint,
            PushSubscription.p256dh,
            PushSubscription.auth,
            Notification.title,
            Notification.body,
            Notification.kind,
            Notification.urgent,
            WorkOrder.status,
            WorkOrder.issued_at,
            WorkOrder.deadline,
            WorkOrder.attempt,
            WorkOrder.number,
            WorkOrder.description,
        )
        .select_from(PushDelivery)
        .join(Notification, Notification.id == PushDelivery.notification_id)
        .join(PushSubscription, PushSubscription.id == PushDelivery.subscription_id)
        .join(AuthSession, AuthSession.id == PushSubscription.session_id)
        .join(Employee, Employee.id == PushSubscription.employee_id)
        .outerjoin(WorkOrder, WorkOrder.id == Notification.work_order_id)
        .outerjoin(FaultReport, FaultReport.id == Notification.fault_report_id)
        .where(
            PushDelivery.id == claim.delivery_id,
            PushDelivery.lease_token == claim.lease_token,
            PushDelivery.sent_at.is_(None),
            PushDelivery.failed_at.is_(None),
            Notification.employee_id == PushSubscription.employee_id,
            AuthSession.employee_id == PushSubscription.employee_id,
            PushSubscription.disabled_at.is_(None),
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > now,
            Employee.is_active.is_(True),
            or_(order_recipient, report_recipient),
        )
    )
    async with database.sessions() as session:
        row = (await session.execute(statement)).one_or_none()
    if row is None:
        return None
    return _Target(*row)


async def _finish(
    database: Database,
    claim: _Claim,
    now: datetime,
    *,
    sent: bool = False,
    error: str | None = None,
    disable: UUID | None = None,
) -> None:
    """Update only the worker that still owns this lease."""
    values: dict[str, object] = {"lease_until": None, "lease_token": None}
    if sent:
        values["sent_at"] = now
    else:
        values["failed_at"] = now
        values["last_error"] = error
    condition = and_(
        PushDelivery.id == claim.delivery_id,
        PushDelivery.lease_token == claim.lease_token,
        PushDelivery.sent_at.is_(None),
        PushDelivery.failed_at.is_(None),
    )
    async with database.sessions() as session, session.begin():
        completed = await session.scalar(
            update(PushDelivery).where(condition).values(**values).returning(PushDelivery.id)
        )
        if completed is None or disable is None:
            return
        await session.execute(
            update(PushSubscription)
            .where(PushSubscription.id == disable, PushSubscription.disabled_at.is_(None))
            .values(disabled_at=now)
        )


async def _retry_or_fail(
    database: Database,
    claim: _Claim,
    now: datetime,
    max_attempts: int,
    outcome: PushResult,
) -> None:
    if claim.attempts >= max_attempts:
        await _finish(database, claim, now, error="push_attempts_exhausted")
        return
    retry_after = min(max(outcome.retry_after_seconds or 0, 0), _MAX_RETRY_AFTER_SECONDS)
    delay = max(2 ** min(claim.attempts - 1, 8), retry_after)
    values: dict[str, object] = {
        "lease_until": None,
        "lease_token": None,
        "next_attempt_at": now + timedelta(seconds=delay),
        "last_error": "push_retryable_error",
    }
    condition = and_(
        PushDelivery.id == claim.delivery_id,
        PushDelivery.lease_token == claim.lease_token,
        PushDelivery.sent_at.is_(None),
        PushDelivery.failed_at.is_(None),
    )
    async with database.sessions() as session, session.begin():
        await session.execute(update(PushDelivery).where(condition).values(**values))
