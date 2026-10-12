"""Real PostgreSQL acceptance checks for executor fault reports."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import func, select, update
from test_order_api import create_body

from naryadai.application import push_delivery
from naryadai.config import Settings
from naryadai.infrastructure.models import (
    AuthSession,
    EmployeeArea,
    Equipment,
    FaultReport,
    Notification,
    PushDelivery,
    PushSubscription,
    WorkOrder,
)
from naryadai.infrastructure.webpush import PushResult

pytestmark = pytest.mark.asyncio
pytest_plugins = ("test_order_api",)


def _report_body(api, **changes):
    return {
        "equipment_id": str(api["machines"][0].id),
        "master_id": str(api["users"]["master"]),
        "description": "Насос вибрирует и требует осмотра",  # noqa: RUF001
    } | changes


async def _report(api, key: str, **changes):
    response = await api["client"].post(
        "/api/v1/fault-reports",
        json=_report_body(api, **changes),
        headers=api["headers"]["executor"] | {"Idempotency-Key": key},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _settings() -> Settings:
    return Settings(
        web_push_private_key_file="var/ignored-vapid.pem",
        web_push_subject="https://example.test/fault-reports",
    )


async def test_report_create_scope_idempotency_and_master_inbox(api, database) -> None:
    client, headers = api["client"], api["headers"]
    options = await client.get(
        f"/api/v1/fault-reports/masters?equipment_id={api['machines'][0].id}",
        headers=headers["executor"],
    )
    assert options.status_code == 200
    assert {item["id"] for item in options.json()["items"]} == {
        str(api["users"]["master"]),
        str(api["users"]["colleague"]),
    }

    report = await _report(api, "fault-report-create-001")
    assert report["status"] == "open" and report["work_order_number"] is None
    assert (await _report(api, "fault-report-create-001"))["id"] == report["id"]
    conflict = await client.post(
        "/api/v1/fault-reports",
        json=_report_body(api, description="Другая неисправность"),
        headers=headers["executor"] | {"Idempotency-Key": "fault-report-create-001"},
    )
    assert conflict.status_code == 409
    assert (
        await client.post(
            "/api/v1/fault-reports",
            json=_report_body(api, master_id=str(api["users"]["foreign"])),
            headers=headers["executor"] | {"Idempotency-Key": "fault-report-invalid-master"},
        )
    ).status_code == 422

    assert (
        await client.get("/api/v1/fault-reports", headers=headers["manager"])
    ).status_code == 403
    own = await client.get("/api/v1/fault-reports?status=all", headers=headers["executor"])
    assert own.json()["total"] == 1 and own.json()["items"][0]["id"] == report["id"]
    assert (
        await client.get(f"/api/v1/fault-reports/{report['id']}", headers=headers["coworker"])
    ).status_code == 404
    assert (
        await client.get(f"/api/v1/fault-reports/{report['id']}", headers=headers["master"])
    ).status_code == 200

    inbox = await client.get("/api/v1/notifications", headers=headers["master"])
    fault_items = [
        item for item in inbox.json()["items"] if item["fault_report_id"] == report["id"]
    ]
    assert len(fault_items) == 1
    assert fault_items[0]["order_id"] is None and fault_items[0]["action_required"] is True


async def test_convert_is_atomic_notifies_reporter_and_replays_order(api, database) -> None:
    report = await _report(api, "fault-report-convert-001")
    body = create_body(api, fault_report_id=report["id"])
    response = await api["client"].post(
        "/api/v1/work-orders",
        json=body,
        headers=api["headers"]["master"] | {"Idempotency-Key": "convert-report-order-001"},
    )
    assert response.status_code == 201, response.text
    order = response.json()
    replay = await api["client"].post(
        "/api/v1/work-orders",
        json=body,
        headers=api["headers"]["master"] | {"Idempotency-Key": "convert-report-order-001"},
    )
    assert replay.json() == order
    second = await api["client"].post(
        "/api/v1/work-orders",
        json=body,
        headers=api["headers"]["master"] | {"Idempotency-Key": "convert-report-order-002"},
    )
    assert second.status_code == 409

    async with database.sessions() as session:
        stored = await session.get(FaultReport, UUID(report["id"]))
        assert stored is not None and stored.status == "converted" and stored.version == 2
        assert stored.resolved_at is not None
        assert (
            await session.scalar(
                select(func.count())
                .select_from(WorkOrder)
                .where(WorkOrder.fault_report_id == stored.id)
            )
            == 1
        )
        linked_order = await session.scalar(
            select(WorkOrder).where(WorkOrder.fault_report_id == stored.id)
        )
        assert linked_order is not None
        notices = list(
            await session.scalars(
                select(Notification).where(
                    Notification.employee_id == api["users"]["executor"],
                    Notification.fault_report_id == stored.id,
                )
            )
        )
        assert [notice.kind for notice in notices] == ["fault_report_converted"]

    view = await api["client"].get(
        f"/api/v1/fault-reports/{report['id']}", headers=api["headers"]["executor"]
    )
    assert view.json()["work_order_number"] == linked_order.number


async def test_concurrent_convert_and_dismiss_leave_one_terminal_result(api, database) -> None:
    report = await _report(api, "fault-report-race-001")
    convert = api["client"].post(
        "/api/v1/work-orders",
        json=create_body(api, fault_report_id=report["id"]),
        headers=api["headers"]["master"] | {"Idempotency-Key": "convert-report-race-001"},
    )
    dismiss = api["client"].post(
        f"/api/v1/fault-reports/{report['id']}/dismiss",
        json={"expected_version": 1, "reason": "Повторный сигнал уже устранён"},
        headers=api["headers"]["master"],
    )
    converted, dismissed = await asyncio.gather(convert, dismiss)
    assert sorted([converted.status_code, dismissed.status_code]) in ([200, 409], [201, 409])
    async with database.sessions() as session:
        stored = await session.get(FaultReport, UUID(report["id"]))
        assert stored is not None and stored.status in {"converted", "dismissed"}
        assert stored.version == 2
        linked = await session.scalar(
            select(func.count())
            .select_from(WorkOrder)
            .where(WorkOrder.fault_report_id == stored.id)
        )
        assert linked == (1 if stored.status == "converted" else 0)


async def test_two_converters_cannot_link_two_orders(api, database) -> None:
    report = await _report(api, "fault-report-two-converters-001")
    body = create_body(api, fault_report_id=report["id"])
    first = api["client"].post(
        "/api/v1/work-orders",
        json=body,
        headers=api["headers"]["master"] | {"Idempotency-Key": "convert-one-001"},
    )
    second = api["client"].post(
        "/api/v1/work-orders",
        json=body,
        headers=api["headers"]["master"] | {"Idempotency-Key": "convert-two-001"},
    )
    responses = await asyncio.gather(first, second)
    assert sorted(response.status_code for response in responses) == [201, 409]
    async with database.sessions() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(WorkOrder)
                .where(WorkOrder.fault_report_id == UUID(report["id"]))
            )
            == 1
        )


async def test_dismiss_retry_scope_revocation_and_invalid_order_keep_report_consistent(
    api, database
) -> None:
    report = await _report(api, "fault-report-dismiss-001")
    client, headers = api["client"], api["headers"]
    other_master = await client.post(
        f"/api/v1/fault-reports/{report['id']}/dismiss",
        json={"expected_version": 1, "reason": "Нет прав на чужое сообщение"},
        headers=headers["colleague"],
    )
    assert other_master.status_code == 404
    bad_order = await client.post(
        "/api/v1/work-orders",
        json=create_body(
            api, equipment_id=str(api["machines"][1].id), fault_report_id=report["id"]
        ),
        headers=headers["master"] | {"Idempotency-Key": "bad-fault-conversion-001"},
    )
    assert bad_order.status_code == 422
    async with database.sessions() as session:
        stored = await session.get(FaultReport, UUID(report["id"]))
        assert stored is not None and stored.status == "open" and stored.version == 1

    dismissed = await client.post(
        f"/api/v1/fault-reports/{report['id']}/dismiss",
        json={"expected_version": 1, "reason": "Оборудование исправно после осмотра"},
        headers=headers["master"],
    )
    assert dismissed.status_code == 200
    assert (
        await client.post(
            f"/api/v1/fault-reports/{report['id']}/dismiss",
            json={"expected_version": 1, "reason": "Оборудование исправно после осмотра"},
            headers=headers["master"],
        )
    ).json() == dismissed.json()
    assert (
        await client.post(
            f"/api/v1/fault-reports/{report['id']}/dismiss",
            json={"expected_version": 2, "reason": "Другая причина"},
            headers=headers["master"],
        )
    ).status_code == 409

    fresh = await _report(api, "fault-report-scope-revoked-001")
    async with database.sessions.begin() as session:
        await session.execute(
            update(EmployeeArea)
            .where(
                EmployeeArea.employee_id == api["users"]["master"],
                EmployeeArea.area_id == api["areas"][0].id,
            )
            .values(area_id=api["areas"][1].id)
        )
    assert (
        await client.get(f"/api/v1/fault-reports/{fresh['id']}", headers=headers["master"])
    ).status_code == 404
    replay_after_revoke = await client.post(
        "/api/v1/fault-reports",
        json=_report_body(api),
        headers=headers["executor"] | {"Idempotency-Key": "fault-report-scope-revoked-001"},
    )
    assert replay_after_revoke.status_code == 422


async def test_fault_report_push_is_delivered_only_while_master_keeps_area_access(
    api, database, monkeypatch
) -> None:
    async with database.sessions.begin() as session:
        auth = await session.scalar(
            select(AuthSession)
            .where(AuthSession.employee_id == api["users"]["master"])
            .order_by(AuthSession.created_at.desc())
        )
        assert auth is not None
        session.add(
            PushSubscription(
                employee_id=auth.employee_id,
                session_id=auth.id,
                endpoint="https://fcm.googleapis.com/fcm/send/fault-report-test",
                endpoint_hash="fault-report-push-test",
                p256dh="p",
                auth="a",
            )
        )

    sent: list[str] = []

    async def accepted(*_args, **kwargs):
        sent.append(kwargs["endpoint"])
        return PushResult(201, None, None)

    monkeypatch.setattr(push_delivery, "send_web_push", accepted)
    first = await _report(api, "fault-report-push-001")
    now = datetime.now(UTC)
    assert await push_delivery.deliver_push(database, settings=_settings(), now=now) == 1
    assert sent

    second = await _report(api, "fault-report-push-002")
    async with database.sessions.begin() as session:
        await session.execute(
            update(EmployeeArea)
            .where(
                EmployeeArea.employee_id == api["users"]["master"],
                EmployeeArea.area_id == api["areas"][0].id,
            )
            .values(area_id=api["areas"][1].id)
        )
    assert (
        await push_delivery.deliver_push(database, settings=_settings(), now=datetime.now(UTC)) == 0
    )
    async with database.sessions() as session:
        delivery = await session.scalar(
            select(PushDelivery)
            .join(Notification, Notification.id == PushDelivery.notification_id)
            .where(Notification.fault_report_id == UUID(second["id"]))
        )
        assert delivery is not None and delivery.last_error == "push_recipient_ineligible"
        assert await session.get(FaultReport, UUID(first["id"])) is not None


async def test_archived_equipment_keeps_history_but_blocks_new_triage(api, database) -> None:
    report = await _report(api, "fault-report-archive-001")
    async with database.sessions.begin() as session:
        await session.execute(
            update(Equipment).where(Equipment.id == api["machines"][0].id).values(is_active=False)
        )
    client, headers = api["client"], api["headers"]
    assert (
        await client.get(f"/api/v1/fault-reports/{report['id']}", headers=headers["executor"])
    ).status_code == 200
    assert (
        await client.get(
            f"/api/v1/fault-reports/masters?equipment_id={api['machines'][0].id}",
            headers=headers["executor"],
        )
    ).status_code == 422
    conversion = await client.post(
        "/api/v1/work-orders",
        json=create_body(api, fault_report_id=report["id"]),
        headers=headers["master"] | {"Idempotency-Key": "archived-report-convert-001"},
    )
    assert conversion.status_code == 409
    async with database.sessions() as session:
        stored = await session.get(FaultReport, UUID(report["id"]))
        assert stored is not None and stored.status == "open" and stored.version == 1
