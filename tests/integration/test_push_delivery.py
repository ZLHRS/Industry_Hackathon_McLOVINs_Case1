from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import update

from naryadai.application import push_delivery
from naryadai.config import Settings
from naryadai.domain.lifecycle import ActorRole, WorkOrderStatus
from naryadai.infrastructure.models import (
    Area,
    AuthSession,
    Employee,
    EmployeeArea,
    Equipment,
    Notification,
    PushDelivery,
    PushSubscription,
    WorkOrder,
    WorkOrderEvent,
)
from naryadai.infrastructure.webpush import PushResult

pytestmark = pytest.mark.asyncio


async def test_device_body_preserves_full_inbox_copy_but_shortens_lock_screen_copy() -> None:
    detailed = (
        "Проверьте назначение: рекомендуемый свободный исполнитель — Илья. "
        "Рекомендация основана на участке, специальности, разряде и отсутствии наряда в работе."
    )
    assert push_delivery._device_body("acceptance_escalation", detailed) == (
        "Исполнитель не подтвердил наряд. Откройте карточку: есть рекомендация по замене."
    )
    assert push_delivery._device_body("overdue", "Подробности в наряде") == (
        "Срок истёк. Откройте наряд и обновите статус работ."
    )
    assert push_delivery._device_body("assignment", "Подтвердите получение.") == (
        "Подтвердите получение."
    )


async def _delivery(database, *, role: str = "executor") -> tuple[PushDelivery, PushSubscription]:
    now = datetime.now(UTC)
    async with database.sessions.begin() as session:
        area = Area(code="PUSH", name="Push area")
        session.add(area)
        await session.flush()
        executor = Employee(
            login="push-executor",
            display_name="Executor",
            role="executor",
            specialty="mechanic",
            grade=3,
            password_hash="x" * 32,
        )
        recipient = (
            executor
            if role == "executor"
            else Employee(
                login=f"push-{role}",
                display_name=role,
                role=role,
                specialty="mechanic",
                grade=4,
                password_hash="y" * 32,
            )
        )
        master = (
            recipient
            if role == "master"
            else Employee(
                login="push-master",
                display_name="Master",
                role="master",
                specialty="mechanic",
                grade=5,
                password_hash="z" * 32,
            )
        )
        area_members = [executor]
        if recipient is not executor:
            area_members.append(recipient)
        if master is not executor and master is not recipient:
            area_members.append(master)
        session.add_all(area_members)
        await session.flush()
        session.add_all(
            EmployeeArea(employee_id=person.id, area_id=area.id) for person in area_members
        )
        equipment = Equipment(
            inventory_number=f"PUSH-{role}",
            name="Pump",
            area_id=area.id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        order = WorkOrder(
            number=f"PUSH-{role}",
            work_type="unplanned",
            description="Push test",
            area_id=area.id,
            equipment_id=equipment.id,
            executor_id=executor.id,
            master_id=master.id,
            priority="normal",
            status="issued",
            issued_at=now,
            deadline=now + timedelta(hours=1),
        )
        session.add(order)
        await session.flush()
        auth = AuthSession(
            employee_id=recipient.id,
            token_hash=(role[0] * 64),
            created_at=now,
            expires_at=now + timedelta(hours=1),
        )
        session.add(auth)
        await session.flush()
        subscription = PushSubscription(
            employee_id=recipient.id,
            session_id=auth.id,
            endpoint="https://fcm.googleapis.com/fcm/send/token",
            endpoint_hash=f"hash-{role}",
            p256dh="p",
            auth="a",
        )
        notification = Notification(
            employee_id=recipient.id,
            work_order_id=order.id,
            dedup_key=f"delivery-{role}",
            kind="test",
            title="Test",
            body="Internal",
            payload={},
        )
        session.add_all([subscription, notification])
        await session.flush()
        delivery = PushDelivery(
            notification_id=notification.id, subscription_id=subscription.id, next_attempt_at=now
        )
        session.add(delivery)
        await session.flush()
        return delivery, subscription


async def _configure_reminder(
    database,
    delivery: PushDelivery,
    *,
    kind: str,
    now: datetime,
    status: WorkOrderStatus,
    deadline: datetime,
    attempt: int = 1,
    dedup_attempt: int | None = None,
    dedup_deadline: datetime | None = None,
    created_at: datetime | None = None,
    read_at: datetime | None = None,
    acknowledged_at: datetime | None = None,
) -> UUID:
    async with database.sessions.begin() as session:
        notification = await session.get(Notification, delivery.notification_id)
        assert notification is not None and notification.work_order_id is not None
        order = await session.get(WorkOrder, notification.work_order_id)
        queued = await session.get(PushDelivery, delivery.id)
        assert order is not None and queued is not None
        order.status = status
        if deadline < order.issued_at:
            order.issued_at = deadline - timedelta(minutes=1)
        order.deadline = deadline
        order.attempt = attempt
        notification.kind = kind
        notification.created_at = created_at or now
        notification.read_at = read_at
        notification.acknowledged_at = acknowledged_at
        queued.next_attempt_at = now
        bucket = "0"
        if kind == "acceptance_escalation":
            bucket = f"basis:{order.issued_at.isoformat()}"
        notification.dedup_key = (
            f"{kind}:{order.id}:{dedup_attempt or attempt}:"
            f"{(dedup_deadline or deadline).isoformat()}:{bucket}"
        )
        return notification.id


def _settings() -> Settings:
    return Settings(
        web_push_private_key_file="var/ignored-vapid.pem", web_push_subject="https://github.com/a/b"
    )


@pytest.mark.parametrize("role", ["executor", "master", "manager"])
async def test_visible_recipient_delivery_is_accepted(database, monkeypatch, role: str) -> None:
    delivery, _ = await _delivery(database, role=role)
    payloads: list[dict[str, object]] = []

    async def accepted(*_args, **kwargs):
        payloads.append(kwargs["payload"])
        return PushResult(201, None, None)

    monkeypatch.setattr(push_delivery, "send_web_push", accepted)
    delivered = await push_delivery.deliver_push(
        database, settings=_settings(), now=datetime.now(UTC)
    )
    assert delivered == 1
    assert payloads == [
        {
            "notification_id": str(delivery.notification_id),
            "title": "Test",
            "body": "Internal",
            "urgent": False,
            "url": f"/?notification={delivery.notification_id}",
            "tag": str(delivery.notification_id),
        }
    ]
    async with database.sessions() as session:
        assert (await session.get(PushDelivery, delivery.id)).sent_at is not None


async def test_retry_then_gone_disables_subscription(database, monkeypatch) -> None:
    delivery, subscription = await _delivery(database)

    async def unavailable(*_args, **_kwargs):
        return PushResult(503, 60, "push_http_error")

    monkeypatch.setattr(push_delivery, "send_web_push", unavailable)
    now = datetime.now(UTC)
    assert await push_delivery.deliver_push(database, settings=_settings(), now=now) == 0
    async with database.sessions.begin() as session:
        stored = await session.get(PushDelivery, delivery.id)
        assert stored.failed_at is None and stored.next_attempt_at >= now + timedelta(seconds=60)
        await session.execute(
            update(PushDelivery).where(PushDelivery.id == delivery.id).values(next_attempt_at=now)
        )

    async def gone(*_args, **_kwargs):
        return PushResult(410, None, "push_http_error")

    monkeypatch.setattr(push_delivery, "send_web_push", gone)
    await push_delivery.deliver_push(database, settings=_settings(), now=now + timedelta(seconds=1))
    async with database.sessions() as session:
        assert (await session.get(PushDelivery, delivery.id)).failed_at is not None
        assert (await session.get(PushSubscription, subscription.id)).disabled_at is not None


async def test_revoked_session_is_terminal_without_transport(database, monkeypatch) -> None:
    delivery, subscription = await _delivery(database)

    async def unexpected(*_args, **_kwargs):
        raise AssertionError("revoked subscription must not be sent")

    monkeypatch.setattr(push_delivery, "send_web_push", unexpected)
    async with database.sessions.begin() as session:
        await session.execute(
            update(AuthSession)
            .where(AuthSession.id == subscription.session_id)
            .values(revoked_at=datetime.now(UTC))
        )
    await push_delivery.deliver_push(database, settings=_settings(), now=datetime.now(UTC))
    async with database.sessions() as session:
        stored = await session.get(PushDelivery, delivery.id)
        assert stored.last_error == "push_recipient_ineligible"


async def test_workers_claim_one_delivery_once(database, monkeypatch) -> None:
    await _delivery(database)
    calls = 0

    async def accepted(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return PushResult(201, None, None)

    monkeypatch.setattr(push_delivery, "send_web_push", accepted)
    now = datetime.now(UTC)
    first, second = await asyncio.gather(
        push_delivery.deliver_push(database, settings=_settings(), now=now),
        push_delivery.deliver_push(database, settings=_settings(), now=now),
    )
    assert first + second == 1
    assert calls == 1


async def test_final_attempt_waits_for_its_active_lease(database, monkeypatch) -> None:
    delivery, _ = await _delivery(database)

    async def unexpected(*_args, **_kwargs):
        raise AssertionError("leased final attempt must not be changed or sent")

    monkeypatch.setattr(push_delivery, "send_web_push", unexpected)
    now = datetime.now(UTC)
    async with database.sessions.begin() as session:
        await session.execute(
            update(PushDelivery)
            .where(PushDelivery.id == delivery.id)
            .values(attempts=5, lease_token=uuid4(), lease_until=now + timedelta(seconds=30))
        )
    assert await push_delivery.deliver_push(database, settings=_settings(), now=now) == 0
    async with database.sessions() as session:
        stored = await session.get(PushDelivery, delivery.id)
        assert stored.failed_at is None


@pytest.mark.parametrize("seen_field", ["read_at", "acknowledged_at"])
async def test_seen_reminder_does_not_reach_device(database, monkeypatch, seen_field: str) -> None:
    now = datetime.now(UTC)
    delivery, _ = await _delivery(database)
    seen_at = now - timedelta(minutes=1)
    await _configure_reminder(
        database,
        delivery,
        kind="deadline_reminder",
        now=now,
        status=WorkOrderStatus.ISSUED,
        deadline=now + timedelta(minutes=30),
        **{seen_field: seen_at},
    )

    async def unexpected(*_args, **_kwargs):
        raise AssertionError("seen reminder must not be sent")

    monkeypatch.setattr(push_delivery, "send_web_push", unexpected)
    assert await push_delivery.deliver_push(database, settings=_settings(), now=now) == 0
    async with database.sessions() as session:
        stored = await session.get(PushDelivery, delivery.id)
        assert stored is not None and stored.last_error == "push_notification_seen"


@pytest.mark.parametrize(
    ("kind", "status", "deadline_offset", "created_offset", "attempt", "dedup_attempt"),
    [
        (
            "deadline_reminder",
            WorkOrderStatus.ISSUED,
            timedelta(minutes=-1),
            timedelta(),
            1,
            None,
        ),
        (
            "deadline_reminder",
            WorkOrderStatus.ISSUED,
            timedelta(minutes=30),
            timedelta(hours=-2, seconds=-1),
            1,
            None,
        ),
        (
            "deadline_reminder",
            WorkOrderStatus.ISSUED,
            timedelta(minutes=30),
            timedelta(),
            2,
            1,
        ),
        (
            "overdue",
            WorkOrderStatus.CANCELLED,
            timedelta(minutes=-10),
            timedelta(),
            1,
            None,
        ),
        (
            "acceptance_escalation",
            WorkOrderStatus.ACCEPTED,
            timedelta(minutes=30),
            timedelta(),
            1,
            None,
        ),
    ],
)
async def test_stale_reminder_context_does_not_reach_device(
    database,
    monkeypatch,
    kind: str,
    status: WorkOrderStatus,
    deadline_offset: timedelta,
    created_offset: timedelta,
    attempt: int,
    dedup_attempt: int | None,
) -> None:
    now = datetime.now(UTC)
    delivery, _ = await _delivery(database)
    await _configure_reminder(
        database,
        delivery,
        kind=kind,
        now=now,
        status=status,
        deadline=now + deadline_offset,
        created_at=now + created_offset,
        attempt=attempt,
        dedup_attempt=dedup_attempt,
    )

    async def unexpected(*_args, **_kwargs):
        raise AssertionError("stale reminder must not be sent")

    monkeypatch.setattr(push_delivery, "send_web_push", unexpected)
    assert await push_delivery.deliver_push(database, settings=_settings(), now=now) == 0
    async with database.sessions() as session:
        stored = await session.get(PushDelivery, delivery.id)
        assert stored is not None and stored.last_error == "push_notification_stale"


async def test_newer_same_order_reminder_suppresses_older_pending_push(
    database, monkeypatch
) -> None:
    now = datetime.now(UTC)
    delivery, _ = await _delivery(database)
    notification_id = await _configure_reminder(
        database,
        delivery,
        kind="overdue",
        now=now,
        status=WorkOrderStatus.IN_PROGRESS,
        deadline=now - timedelta(minutes=10),
        created_at=now - timedelta(minutes=1),
    )
    async with database.sessions.begin() as session:
        old = await session.get(Notification, notification_id)
        assert old is not None and old.work_order_id is not None
        session.add(
            Notification(
                employee_id=old.employee_id,
                work_order_id=old.work_order_id,
                dedup_key="overdue-newer-pending",
                kind="overdue",
                title="Новый overdue",
                body="Новый overdue",
                payload={},
                created_at=now,
            )
        )

    async def unexpected(*_args, **_kwargs):
        raise AssertionError("superseded reminder must not be sent")

    monkeypatch.setattr(push_delivery, "send_web_push", unexpected)
    assert await push_delivery.deliver_push(database, settings=_settings(), now=now) == 0
    async with database.sessions() as session:
        stored = await session.get(PushDelivery, delivery.id)
        assert stored is not None and stored.last_error == "push_notification_superseded"


async def test_lifecycle_update_push_is_not_suppressed_by_reminder_rules(
    database, monkeypatch
) -> None:
    now = datetime.now(UTC)
    delivery, _ = await _delivery(database)
    async with database.sessions.begin() as session:
        notification = await session.get(Notification, delivery.notification_id)
        assert notification is not None and notification.work_order_id is not None
        order = await session.get(WorkOrder, notification.work_order_id)
        assert order is not None
        notification.kind = "assignment"
        order.status = WorkOrderStatus.CLOSED
        order.issued_at = now - timedelta(minutes=3)
        order.started_at = now - timedelta(minutes=2)
        order.completed_at = now - timedelta(minutes=1)
        order.closed_at = now
        delivery_row = await session.get(PushDelivery, delivery.id)
        assert delivery_row is not None
        delivery_row.next_attempt_at = now

    async def accepted(*_args, **_kwargs):
        return PushResult(201, None, None)

    monkeypatch.setattr(push_delivery, "send_web_push", accepted)
    assert await push_delivery.deliver_push(database, settings=_settings(), now=now) == 1
    async with database.sessions() as session:
        stored = await session.get(PushDelivery, delivery.id)
        assert stored is not None and stored.sent_at is not None


@pytest.mark.parametrize(
    ("kind", "status", "deadline_offset"),
    [
        ("deadline_reminder", WorkOrderStatus.ISSUED, timedelta(minutes=30)),
        ("overdue", WorkOrderStatus.IN_PROGRESS, timedelta(minutes=-10)),
        ("manager_overdue", WorkOrderStatus.PAUSED, timedelta(minutes=-10)),
        ("acceptance_escalation", WorkOrderStatus.ISSUED, timedelta(minutes=30)),
    ],
)
async def test_fresh_current_reminder_reaches_device(
    database,
    monkeypatch,
    kind: str,
    status: WorkOrderStatus,
    deadline_offset: timedelta,
) -> None:
    now = datetime.now(UTC)
    delivery, _ = await _delivery(database)
    await _configure_reminder(
        database,
        delivery,
        kind=kind,
        now=now,
        status=status,
        deadline=now + deadline_offset,
    )
    calls = 0

    async def accepted(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return PushResult(201, None, None)

    monkeypatch.setattr(push_delivery, "send_web_push", accepted)
    assert await push_delivery.deliver_push(database, settings=_settings(), now=now) == 1
    assert calls == 1


async def test_reassignment_makes_old_acceptance_escalation_stale(database, monkeypatch) -> None:
    now = datetime.now(UTC)
    delivery, _ = await _delivery(database)
    notification_id = await _configure_reminder(
        database,
        delivery,
        kind="acceptance_escalation",
        now=now,
        status=WorkOrderStatus.ISSUED,
        deadline=now + timedelta(minutes=30),
    )
    async with database.sessions.begin() as session:
        notification = await session.get(Notification, notification_id)
        assert notification is not None and notification.work_order_id is not None
        order = await session.get(WorkOrder, notification.work_order_id)
        assert order is not None
        session.add(
            WorkOrderEvent(
                work_order_id=order.id,
                sequence=1,
                order_version=order.version,
                actor_id=order.master_id,
                actor_role=ActorRole.MASTER,
                action="reassign",
                from_status=WorkOrderStatus.ISSUED,
                to_status=WorkOrderStatus.ISSUED,
                details={"attempt": order.attempt},
                occurred_at=now,
            )
        )

    async def unexpected(*_args, **_kwargs):
        raise AssertionError("old acceptance escalation must not be sent")

    monkeypatch.setattr(push_delivery, "send_web_push", unexpected)
    assert await push_delivery.deliver_push(database, settings=_settings(), now=now) == 0
    async with database.sessions() as session:
        stored = await session.get(PushDelivery, delivery.id)
        assert stored is not None and stored.last_error == "push_notification_stale"
