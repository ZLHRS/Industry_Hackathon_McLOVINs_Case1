"""Persistent notification policy, transactional outbox fanout, and deadline scanning."""

from __future__ import annotations

from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from naryadai.domain.lifecycle import WorkOrderStatus
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    Area,
    AuthSession,
    Employee,
    EmployeeArea,
    EmployeeRole,
    Equipment,
    FaultCode,
    Notification,
    OutboxEvent,
    PushDelivery,
    PushSubscription,
    RealtimeRevision,
    WorkOrder,
    WorkOrderEvent,
)


@dataclass(frozen=True, slots=True)
class NotificationPolicy:
    reminder_minutes: int = 30
    acceptance_minutes: int = 10
    emergency_acceptance_minutes: int = 3
    overdue_repeat_minutes: int = 30
    manager_escalation_minutes: int = 60

    def __post_init__(self) -> None:
        if any(
            value <= 0
            for value in (
                self.reminder_minutes,
                self.acceptance_minutes,
                self.emergency_acceptance_minutes,
                self.overdue_repeat_minutes,
                self.manager_escalation_minutes,
            )
        ):
            raise ValueError("notification policy intervals must be positive")


_ACTIVE_DEADLINE_STATUSES = frozenset(
    {
        WorkOrderStatus.ISSUED,
        WorkOrderStatus.ACCEPTED,
        WorkOrderStatus.QUEUED,
        WorkOrderStatus.IN_PROGRESS,
        WorkOrderStatus.PAUSED,
        WorkOrderStatus.REWORK,
    }
)


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("now must be timezone-aware UTC")
    return value


def _bucket(elapsed: timedelta, interval: timedelta) -> int:
    return int(elapsed.total_seconds() // interval.total_seconds())


def _dedup(order: WorkOrder, kind: str, bucket: str) -> str:
    return f"{kind}:{order.id}:{order.attempt}:{order.deadline.isoformat()}:{bucket}"


_STATUS_LABELS = {
    WorkOrderStatus.ISSUED: "выдан",
    WorkOrderStatus.ACCEPTED: "принят",
    WorkOrderStatus.QUEUED: "в очереди",
    WorkOrderStatus.REJECTED: "отклонён",
    WorkOrderStatus.IN_PROGRESS: "в работе",
    WorkOrderStatus.PAUSED: "приостановлен",
    WorkOrderStatus.COMPLETED: "выполнен",
    WorkOrderStatus.AI_REVIEW: "на проверке ИИ",
    WorkOrderStatus.REWORK: "на доработке",
    WorkOrderStatus.CLOSED: "закрыт",
    WorkOrderStatus.CANCELLED: "отменён",
}


async def _order_context(session: AsyncSession, order: WorkOrder, now: datetime) -> dict[str, Any]:
    """Return the minimal human-readable context required for deadline alerts."""

    area = await session.get(Area, order.area_id)
    equipment = await session.get(Equipment, order.equipment_id)
    executor = await session.get(Employee, order.executor_id)
    delay_minutes = max(0, int((now - order.deadline).total_seconds() // 60))
    return {
        "number": order.number,
        "equipment": (equipment.name if equipment is not None else "Оборудование не найдено"),
        "equipment_number": (equipment.inventory_number if equipment is not None else "—"),
        "area": area.name if area is not None else "Участок не найден",
        "executor": executor.display_name if executor is not None else "Исполнитель не найден",
        "status": _STATUS_LABELS[order.status],
        "overdue_minutes": delay_minutes,
        "comment": order.comment or "Нет комментария",
    }


def _overdue_body(context: dict[str, Any]) -> str:
    return (
        f"Наряд {context['number']}: {context['equipment']} "
        f"({context['equipment_number']}), участок {context['area']}. "
        f"Исполнитель: {context['executor']}. Статус: {context['status']}. "
        f"Просрочка: {context['overdue_minutes']} мин. "
        f"Комментарий: {context['comment']}."
    )


async def _bump_revision(session: AsyncSession, employee_id: UUID, now: datetime) -> None:
    statement = insert(RealtimeRevision).values(employee_id=employee_id, revision=1, updated_at=now)
    await session.execute(
        statement.on_conflict_do_update(
            index_elements=[RealtimeRevision.employee_id],
            set_={
                "revision": RealtimeRevision.revision + 1,
                "updated_at": now,
            },
        )
    )


async def _new_notification(
    session: AsyncSession,
    *,
    employee_id: UUID,
    order: WorkOrder,
    dedup_key: str,
    kind: str,
    title: str,
    body: str,
    urgent: bool,
    action_required: bool,
    payload: dict[str, Any],
    now: datetime,
    bump_revision: bool = True,
) -> bool:
    """Insert once, revision-bump and enqueue only current valid push sessions."""

    statement = insert(Notification).values(
        id=uuid4(),
        employee_id=employee_id,
        work_order_id=order.id,
        dedup_key=dedup_key,
        kind=kind,
        title=title,
        body=body,
        urgent=urgent,
        action_required=action_required,
        payload=payload,
        created_at=now,
    )
    notification_id = await session.scalar(
        statement.on_conflict_do_nothing(
            index_elements=[Notification.employee_id, Notification.dedup_key]
        ).returning(Notification.id)
    )
    if notification_id is None:
        return False
    if bump_revision:
        await _bump_revision(session, employee_id, now)
    subscriptions = (
        await session.scalars(
            select(PushSubscription.id)
            .join(AuthSession, AuthSession.id == PushSubscription.session_id)
            .where(
                PushSubscription.employee_id == employee_id,
                PushSubscription.disabled_at.is_(None),
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > now,
            )
        )
    ).all()
    for subscription_id in subscriptions:
        await session.execute(
            insert(PushDelivery)
            .values(
                id=uuid4(),
                notification_id=notification_id,
                subscription_id=subscription_id,
                next_attempt_at=now,
            )
            .on_conflict_do_nothing(
                index_elements=[PushDelivery.notification_id, PushDelivery.subscription_id]
            )
        )
    return True


async def _event_recipients(
    session: AsyncSession, order: WorkOrder, event: WorkOrderEvent
) -> tuple[list[UUID], str, str, bool, bool]:
    """Map one relevant current-attempt event to private recipients and copy-safe text."""

    if event.action in {"issue", "reassign"}:
        return (
            [order.executor_id],
            "assignment",
            f"Назначен наряд {order.number}",
            order.priority.value == "emergency",
            True,
        )
    if event.action in {"record_ai_assessment", "mark_rework"}:
        return (
            list(dict.fromkeys([order.master_id, order.executor_id])),
            "review_ready",
            f"Готова проверка ремонта: {order.number}",
            False,
            True,
        )
    if event.action in {"close", "override_close", "request_rework"}:
        rework = event.action == "request_rework"
        return (
            [order.executor_id],
            "master_decision",
            f"Наряд {order.number}: " + ("требуется доработка" if rework else "принят мастером"),
            False,
            rework,
        )
    if event.action == "start_ai_review":
        # The final review event provides one notification with useful evidence.
        return ([], "workflow", "", False, False)
    if event.from_status == event.to_status:
        return ([], "workflow", "", False, False)
    status = "изменён" if event.to_status is None else _STATUS_LABELS[event.to_status]
    return (
        [order.master_id],
        "workflow",
        f"Наряд {order.number}: статус {status}",
        False,
        False,
    )


async def _bump_current_viewers(
    session: AsyncSession, order: WorkOrder, event: WorkOrderEvent | None, now: datetime
) -> None:
    """Bump every current order viewer even when an old event has no inbox alert."""

    viewers = set(
        (
            await session.scalars(
                select(Employee.id)
                .outerjoin(EmployeeArea, EmployeeArea.employee_id == Employee.id)
                .where(
                    Employee.is_active.is_(True),
                    (
                        (Employee.id == order.executor_id)
                        | (
                            (Employee.role.in_((EmployeeRole.MASTER, EmployeeRole.MANAGER)))
                            & (EmployeeArea.area_id == order.area_id)
                        )
                    ),
                )
            )
        ).all()
    )
    previous = event.details.get("previous_executor_id") if event is not None else None
    if isinstance(previous, str):
        with suppress(ValueError):
            viewers.add(UUID(previous))
    for employee_id in viewers:
        await _bump_revision(session, employee_id, now)


async def invalidate_order_views(session: AsyncSession, order: WorkOrder, now: datetime) -> None:
    """Publish job progress to current viewers without inventing a lifecycle event."""
    await _bump_current_viewers(session, order, None, now)


async def process_outbox(database: Database, *, now: datetime, limit: int = 100) -> int:
    """Fan out current-attempt workflow events and atomically mark them processed."""

    now = _utc(now)
    if not 1 <= limit <= 1_000:
        raise ValueError("limit must be between 1 and 1000")
    created = 0
    async with database.sessions.begin() as session:
        rows = await session.execute(
            select(OutboxEvent, WorkOrderEvent, WorkOrder)
            .join(WorkOrderEvent, WorkOrderEvent.id == OutboxEvent.event_id)
            .join(WorkOrder, WorkOrder.id == OutboxEvent.work_order_id)
            .where(OutboxEvent.processed_at.is_(None))
            .order_by(OutboxEvent.created_at, OutboxEvent.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        for outbox, event, order in rows:
            current_attempt = int(event.details.get("attempt", 1))
            relevant = current_attempt == order.attempt and event.to_status == order.status
            await _bump_current_viewers(session, order, event, now)
            if relevant:
                recipients, kind, title, urgent, action_required = await _event_recipients(
                    session, order, event
                )
                for employee_id in recipients:
                    inserted = await _new_notification(
                        session,
                        employee_id=employee_id,
                        order=order,
                        dedup_key=f"event:{event.id}",
                        kind=kind,
                        title=title,
                        body=f"Наряд {order.number} требует внимания.",
                        urgent=urgent,
                        action_required=action_required,
                        payload={
                            "order_id": str(order.id),
                            "event_id": str(event.id),
                            "kind": kind,
                        },
                        now=now,
                        bump_revision=False,
                    )
                    created += int(inserted)
            outbox.processed_at = now
    return created


async def _acceptance_basis(session: AsyncSession, order: WorkOrder) -> datetime:
    event = await session.scalar(
        select(WorkOrderEvent)
        .where(
            WorkOrderEvent.work_order_id == order.id,
            WorkOrderEvent.action == "reassign",
        )
        .order_by(WorkOrderEvent.sequence.desc())
        .limit(1)
    )
    return order.issued_at if event is None else event.occurred_at


async def _candidate(
    session: AsyncSession, order: WorkOrder, specialty: str, minimum_grade: int
) -> Employee | None:
    busy = select(WorkOrder.executor_id).where(WorkOrder.status == WorkOrderStatus.IN_PROGRESS)
    return cast(
        Employee | None,
        await session.scalar(
            select(Employee)
            .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
            .where(
                Employee.role == EmployeeRole.EXECUTOR,
                Employee.is_active.is_(True),
                Employee.is_on_shift.is_(True),
                EmployeeArea.area_id == order.area_id,
                Employee.specialty == specialty,
                Employee.grade >= minimum_grade,
                Employee.id != order.executor_id,
                Employee.id.not_in(busy),
            )
            .order_by(Employee.grade.desc(), Employee.login)
            .limit(1)
        ),
    )


async def _specialty_baseline(session: AsyncSession, order: WorkOrder) -> tuple[str, int]:
    executor = await session.get(Employee, order.executor_id)
    if executor is None:
        return "", 1
    if order.fault_code_id is None:
        return executor.specialty, executor.grade
    fault = await session.get(FaultCode, order.fault_code_id)
    return (executor.specialty if fault is None else fault.specialty), executor.grade


async def scan_deadlines(database: Database, *, now: datetime, policy: NotificationPolicy) -> int:
    """Create deduplicated deadline, acceptance and escalation inbox entries."""

    now = _utc(now)
    created = 0
    async with database.sessions.begin() as session:
        orders = (
            await session.scalars(
                select(WorkOrder)
                .where(WorkOrder.status.in_(_ACTIVE_DEADLINE_STATUSES))
                .order_by(WorkOrder.deadline, WorkOrder.id)
                .with_for_update(skip_locked=True)
            )
        ).all()
        for order in orders:
            base_payload = {"order_id": str(order.id), "attempt": order.attempt}
            reminder_at = order.deadline - timedelta(minutes=policy.reminder_minutes)
            if reminder_at <= now < order.deadline:
                created += int(
                    await _new_notification(
                        session,
                        employee_id=order.executor_id,
                        order=order,
                        dedup_key=_dedup(order, "deadline_reminder", "once"),
                        kind="deadline_reminder",
                        title=f"Срок наряда {order.number} скоро истекает",
                        body="Выполните наряд или обновите его статус до истечения срока.",  # noqa: RUF001
                        urgent=False,
                        action_required=True,
                        payload=base_payload,
                        now=now,
                    )
                )
            basis = await _acceptance_basis(session, order)
            wait = (
                policy.emergency_acceptance_minutes
                if order.priority.value == "emergency"
                else policy.acceptance_minutes
            )
            if order.status is WorkOrderStatus.ISSUED and now >= basis + timedelta(minutes=wait):
                specialty, grade = await _specialty_baseline(session, order)
                candidate = await _candidate(session, order, specialty, grade)
                candidate_name = "Подходящих свободных исполнителей нет"
                if candidate is not None:
                    candidate_name = candidate.display_name
                key = _dedup(
                    order,
                    "acceptance_escalation",
                    f"basis:{basis.isoformat()}",
                )
                for employee_id in [order.master_id]:
                    created += int(
                        await _new_notification(
                            session,
                            employee_id=employee_id,
                            order=order,
                            dedup_key=key,
                            kind="acceptance_escalation",
                            title=f"Наряд {order.number} не принят",
                            body=(
                                "Проверьте назначение: "
                                f"рекомендуемый свободный исполнитель — {candidate_name}. "
                                "Рекомендация основана на участке, специальности, разряде "
                                "и отсутствии наряда в работе."
                            ),
                            urgent=order.priority.value == "emergency",
                            action_required=True,
                            payload=base_payload
                            | {
                                "candidate_id": None if candidate is None else str(candidate.id),
                                "candidate_name": candidate_name,
                                "candidate_reason": (
                                    "На смене, активен, допущен к участку, соответствует "  # noqa: RUF001
                                    "специальности и разряду, нет наряда в работе."
                                ),
                            },
                            now=now,
                        )
                    )
            if now < order.deadline:
                continue
            context = await _order_context(session, order, now)
            repeat = timedelta(minutes=policy.overdue_repeat_minutes)
            overdue_bucket = str(_bucket(now - order.deadline, repeat))
            key = _dedup(order, "overdue", overdue_bucket)
            for employee_id in (order.executor_id, order.master_id):
                created += int(
                    await _new_notification(
                        session,
                        employee_id=employee_id,
                        order=order,
                        dedup_key=key,
                        kind="overdue",
                        title=f"Просрочен наряд {order.number}",
                        body=_overdue_body(context),
                        urgent=True,
                        action_required=True,
                        payload=base_payload | context,
                        now=now,
                    )
                )
            manager_after = order.deadline + timedelta(minutes=policy.manager_escalation_minutes)
            if now >= manager_after:
                managers = (
                    await session.scalars(
                        select(Employee.id)
                        .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
                        .where(
                            Employee.role == EmployeeRole.MANAGER,
                            Employee.is_active.is_(True),
                            EmployeeArea.area_id == order.area_id,
                        )
                    )
                ).all()
                key = _dedup(
                    order,
                    "manager_overdue",
                    str(_bucket(now - manager_after, repeat)),
                )
                for employee_id in managers:
                    created += int(
                        await _new_notification(
                            session,
                            employee_id=employee_id,
                            order=order,
                            dedup_key=key,
                            kind="manager_overdue",
                            title=f"Эскалация просроченного наряда {order.number}",
                            body=(
                                _overdue_body(context)
                                + " Наряд остаётся просроченным после окна эскалации."
                            ),
                            urgent=True,
                            action_required=True,
                            payload=base_payload | context,
                            now=now,
                        )
                    )
    return created
