from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import update

from naryadai.application import push_delivery
from naryadai.config import Settings
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
)
from naryadai.infrastructure.webpush import PushResult

pytestmark = pytest.mark.asyncio


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


def _settings() -> Settings:
    return Settings(
        web_push_private_key_file="var/ignored-vapid.pem", web_push_subject="https://github.com/a/b"
    )


@pytest.mark.parametrize("role", ["executor", "master", "manager"])
async def test_visible_recipient_delivery_is_accepted(database, monkeypatch, role: str) -> None:
    delivery, _ = await _delivery(database, role=role)

    async def accepted(*_args, **_kwargs):
        return PushResult(201, None, None)

    monkeypatch.setattr(push_delivery, "send_web_push", accepted)
    delivered = await push_delivery.deliver_push(
        database, settings=_settings(), now=datetime.now(UTC)
    )
    assert delivered == 1
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
