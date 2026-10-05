"""Reporting observations are authorized, immutable, versioned and retry-safe."""

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select
from test_order_commands import _create_body, _fixture

from naryadai.application.common import OperationError
from naryadai.application.contracts import OrderAction
from naryadai.application.orders import create_order, execute_action
from naryadai.application.report_evidence import (
    DowntimeRecord,
    RefusalAssessment,
    save_report_evidence,
)
from naryadai.infrastructure.models import OutboxEvent, WorkOrderEvent

pytestmark = pytest.mark.asyncio


async def _order(database):
    data = await _fixture(database)
    result = await create_order(database, data["master"], _create_body(data), "evidence-create")
    return data, UUID(result["order_id"])


def _interval(version=1, **overrides):
    now = datetime.now(UTC)
    return DowntimeRecord(
        **{
            "expected_version": version,
            "started_at": now - timedelta(hours=2),
            "ended_at": now - timedelta(hours=1),
            "reason": "Equipment stopped for repair",
            **overrides,
        }
    )


async def test_interval_audit_correction_void_and_idempotent_replay(database):
    data, order_id = await _order(database)
    body = _interval()
    original = await save_report_evidence(database, data["master"], order_id, body, "downtime-one")
    assert original["version"] == 2 and original["status"] == "issued"
    replay = await save_report_evidence(database, data["master"], order_id, body, "downtime-one")
    assert replay == original
    correction = _interval(2, ended_at=None)
    await save_report_evidence(database, data["master"], order_id, correction, "downtime-correct")
    await save_report_evidence(
        database,
        data["master"],
        order_id,
        DowntimeRecord(expected_version=3, void=True, reason="Entered on wrong order"),
        "downtime-void",
    )
    async with database.sessions() as session:
        events = list(
            await session.scalars(
                select(WorkOrderEvent)
                .where(
                    WorkOrderEvent.work_order_id == order_id,
                    WorkOrderEvent.action == "record_downtime",
                )
                .order_by(WorkOrderEvent.sequence)
            )
        )
        assert len(events) == 3
        assert events[0].details["ended_at"] == body.ended_at.isoformat()
        assert events[1].details["ended_at"] is None
        assert events[2].details["void"] is True
        assert all(e.from_status == e.to_status for e in events)
        assert await session.scalar(select(func.count()).select_from(OutboxEvent)) == 4


async def test_refusal_must_belong_to_order_and_keeps_actor(database):
    data, order_id = await _order(database)
    await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="reject", expected_version=1, reason="Missing safety equipment"),
        "reject-evidence",
    )
    async with database.sessions() as session:
        rejection = await session.scalar(
            select(WorkOrderEvent).where(
                WorkOrderEvent.work_order_id == order_id, WorkOrderEvent.action == "reject"
            )
        )
    assessment = RefusalAssessment(expected_version=2, justified=True, reason="Confirmed by master")
    with pytest.raises(OperationError, match="rejection_event_not_found"):
        await save_report_evidence(
            database,
            data["master"],
            order_id,
            assessment,
            "assess-wrong",
            rejection_event_id=uuid4(),
        )
    result = await save_report_evidence(
        database,
        data["master"],
        order_id,
        assessment,
        "assess-refusal",
        rejection_event_id=rejection.id,
    )
    assert result["status"] == "rejected"
    async with database.sessions() as session:
        event = await session.scalar(
            select(WorkOrderEvent).where(
                WorkOrderEvent.work_order_id == order_id,
                WorkOrderEvent.action == "adjudicate_refusal",
            )
        )
        assert event.details["rejection_event_id"] == str(rejection.id)
        assert event.details["justified"] is True
        assert rejection.actor_id == data["first"].employee_id


async def test_role_owner_scope_future_and_conflict_guards(database):
    data, order_id = await _order(database)
    for principal in (
        data["first"],
        replace(data["master"], role="manager"),
        replace(data["master"], role="admin"),
    ):
        with pytest.raises(OperationError, match="role_not_permitted"):
            await save_report_evidence(database, principal, order_id, _interval(), "not-allowed")
    with pytest.raises(OperationError, match="issuing_master_required"):
        await save_report_evidence(
            database,
            replace(data["master"], employee_id=data["second"].employee_id),
            order_id,
            _interval(),
            "not-owner-key",
        )
    with pytest.raises(OperationError, match="order_not_found"):
        await save_report_evidence(
            database, replace(data["master"], area_ids=()), order_id, _interval(), "not-in-scope"
        )
    with pytest.raises(OperationError, match="version_conflict"):
        await save_report_evidence(
            database, data["master"], order_id, _interval(9), "bad-version-key"
        )
    future = datetime.now(UTC) + timedelta(hours=1)
    with pytest.raises(OperationError, match="downtime_end_in_future"):
        await save_report_evidence(
            database, data["master"], order_id, _interval(ended_at=future), "future-end-key"
        )
    with pytest.raises(OperationError, match="invalid_downtime_interval"):
        await save_report_evidence(
            database,
            data["master"],
            order_id,
            _interval(started_at=future, ended_at=None),
            "future-start-key",
        )
    with pytest.raises(ValidationError):
        _interval(started_at=datetime(2026, 1, 1))
    with pytest.raises(ValidationError):
        _interval(void=True)
    with pytest.raises(ValidationError):
        _interval(ended_at=datetime.now(UTC) - timedelta(days=3))


async def test_concurrent_versions_cannot_overwrite_evidence(database):
    data, order_id = await _order(database)
    results = await asyncio.gather(
        *(
            save_report_evidence(database, data["master"], order_id, _interval(), key)
            for key in ("concurrent-first", "concurrent-second")
        ),
        return_exceptions=True,
    )
    assert sum(isinstance(r, dict) for r in results) == 1
    assert (
        sum(isinstance(r, OperationError) and r.detail == "version_conflict" for r in results) == 1
    )
