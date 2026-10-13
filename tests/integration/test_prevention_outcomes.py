"""HTTP and service checks for prevention outcome tracking."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select
from test_preventive_orders import _client, _create_body, _fixture, _headers, _source

from naryadai.analytics.contracts import AnalyticsQuery
from naryadai.application.orders import create_order
from naryadai.application.prevention_outcomes import prevention_outcomes
from naryadai.domain.lifecycle import ActorRole, WorkOrderStatus
from naryadai.infrastructure.models import (
    Brigade,
    Employee,
    Priority,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

pytestmark = pytest.mark.asyncio


async def _preventive(database, data, source, key):
    created = await create_order(database, data["master"], _create_body(data, source), key)
    async with database.sessions() as session:
        order = await session.get(WorkOrder, created["order_id"])
        assert order is not None
        return order


async def _close(database, data, order_id, *, at, actor_role=ActorRole.MASTER):
    async with database.sessions.begin() as session:
        order = await session.get(WorkOrder, order_id)
        assert order is not None
        order.status = WorkOrderStatus.CLOSED
        order.started_at = at - timedelta(hours=2)
        order.completed_at = at - timedelta(hours=1)
        order.closed_at = at
        order.version += 1
        session.add(
            WorkOrderEvent(
                work_order_id=order.id,
                sequence=2,
                order_version=order.version,
                actor_id=(
                    data["master"].employee_id
                    if actor_role == ActorRole.MASTER
                    else data["executor"].employee_id
                ),
                actor_role=actor_role,
                action="override_close",
                from_status=WorkOrderStatus.AI_REVIEW,
                to_status=WorkOrderStatus.CLOSED,
                occurred_at=at,
                details={"submission_version": 1},
                reason="Контрольное закрытие профилактики.",
            )
        )
        return order


async def _repeat(
    database,
    data,
    *,
    equipment_id,
    fault_code_id,
    issued_at,
    number,
    work_type=WorkType.UNPLANNED,
    status=WorkOrderStatus.ISSUED,
    executor_id=None,
):
    async with database.sessions.begin() as session:
        session.add(
            WorkOrder(
                number=number,
                work_type=work_type,
                description="Контрольный внеплановый ремонт",
                area_id=data["area"],
                equipment_id=equipment_id,
                executor_id=executor_id or data["executor_id"],
                master_id=data["master"].employee_id,
                priority=Priority.HIGH,
                status=status,
                issued_at=issued_at,
                deadline=issued_at + timedelta(days=1),
                fault_code_id=fault_code_id,
                version=1,
                attempt=1,
            )
        )


async def _malformed_prevention(database, data, *, issued_at):
    async with database.sessions.begin() as session:
        order = WorkOrder(
            number="OUTCOME-MALFORMED",
            work_type=WorkType.PLANNED,
            description="Malformed prevention provenance",
            area_id=data["area"],
            equipment_id=data["recurring_equipment"],
            executor_id=data["executor_id"],
            master_id=data["master"].employee_id,
            priority=Priority.PLANNED,
            status=WorkOrderStatus.ISSUED,
            issued_at=issued_at,
            deadline=issued_at + timedelta(days=1),
            version=1,
            attempt=1,
        )
        session.add(order)
        await session.flush()
        session.add(
            WorkOrderEvent(
                work_order_id=order.id,
                sequence=1,
                order_version=1,
                actor_id=data["master"].employee_id,
                actor_role=ActorRole.MASTER,
                action="issue",
                from_status=None,
                to_status=WorkOrderStatus.ISSUED,
                occurred_at=issued_at,
                details={"prevention_source": {"family": []}},
            )
        )
        return order


async def _unreadable_lineage(database, data, *, issued_at):
    missing_id = uuid4()
    async with database.sessions.begin() as session:
        order = WorkOrder(
            number="OUTCOME-UNREADABLE",
            work_type=WorkType.PLANNED,
            description="Unreadable prevention lineage",
            area_id=data["area"],
            equipment_id=data["recurring_equipment"],
            executor_id=data["executor_id"],
            master_id=data["master"].employee_id,
            priority=Priority.PLANNED,
            status=WorkOrderStatus.ISSUED,
            issued_at=issued_at,
            deadline=issued_at + timedelta(days=1),
            version=1,
            attempt=1,
        )
        session.add(order)
        await session.flush()
        session.add(
            WorkOrderEvent(
                work_order_id=order.id,
                sequence=1,
                order_version=1,
                actor_id=data["master"].employee_id,
                actor_role=ActorRole.MASTER,
                action="issue",
                from_status=None,
                to_status=WorkOrderStatus.ISSUED,
                occurred_at=issued_at,
                details={
                    "prevention_source": {
                        "family": "recurring_fault",
                        "equipment_id": str(order.equipment_id),
                        "order_ids": [str(data["foreign_equipment"]), str(missing_id)],
                        "title": "Недоступное основание",
                        "recommendation": "Проверить источник",
                        "formula": "Тест проверяемости источника",
                    }
                },
            )
        )
        return order, missing_id


async def test_prevention_outcomes_trace_source_closure_and_repeat_rules(database, tmp_path):
    data = await _fixture(database)
    async with database.sessions.begin() as session:
        brigade = Brigade(code="OUTCOME", name="Outcome brigade")
        session.add(brigade)
        await session.flush()
        executor = await session.get(Employee, data["executor"].employee_id)
        assert executor is not None
        executor.brigade_id = brigade.id
        brigade_id = brigade.id
    recurring = await _source(database, data, "recurring_fault")
    after_ppr = await _source(database, data, "after_ppr")
    repeat_hit = await _preventive(database, data, recurring, "outcome-repeat-key")
    ppr_hit = await _preventive(database, data, after_ppr, "outcome-ppr-key")
    no_repeat = await _preventive(database, data, recurring, "outcome-clean-key")
    pending = await _preventive(database, data, recurring, "outcome-pending-key")
    cancelled = await _preventive(database, data, recurring, "outcome-cancel-key")
    invalid_close = await _preventive(database, data, recurring, "outcome-invalid-key")
    base = datetime.now(UTC).replace(microsecond=0)
    closed_repeat = await _close(database, data, repeat_hit.id, at=base + timedelta(days=1))
    closed_ppr = await _close(database, data, ppr_hit.id, at=base + timedelta(days=1))
    await _close(database, data, no_repeat.id, at=base + timedelta(days=10))
    await _close(
        database,
        data,
        invalid_close.id,
        at=base + timedelta(days=1),
        actor_role=ActorRole.EXECUTOR,
    )
    async with database.sessions.begin() as session:
        order = await session.get(WorkOrder, cancelled.id)
        assert order is not None
        order.status = WorkOrderStatus.CANCELLED
        order = await session.get(WorkOrder, repeat_hit.id)
        assert order is not None
        order.fault_code_id = None
    await _repeat(
        database,
        data,
        equipment_id=repeat_hit.equipment_id,
        fault_code_id=data["fault"],
        issued_at=closed_repeat.closed_at + timedelta(days=7),
        number="OUTCOME-REPEAT",
        executor_id=data["master"].employee_id,
    )
    for number, issued_at, work_type, status in (
        ("OUTCOME-EQUAL", closed_repeat.closed_at, WorkType.UNPLANNED, WorkOrderStatus.ISSUED),
        (
            "OUTCOME-LATE",
            closed_repeat.closed_at + timedelta(days=8),
            WorkType.UNPLANNED,
            WorkOrderStatus.ISSUED,
        ),
        (
            "OUTCOME-CANCELLED",
            closed_repeat.closed_at + timedelta(days=2),
            WorkType.UNPLANNED,
            WorkOrderStatus.CANCELLED,
        ),
        (
            "OUTCOME-PLANNED",
            closed_repeat.closed_at + timedelta(days=2),
            WorkType.PLANNED,
            WorkOrderStatus.ISSUED,
        ),
        (
            "OUTCOME-FUTURE",
            base + timedelta(days=19),
            WorkType.UNPLANNED,
            WorkOrderStatus.ISSUED,
        ),
    ):
        await _repeat(
            database,
            data,
            equipment_id=repeat_hit.equipment_id,
            fault_code_id=data["fault"],
            issued_at=issued_at,
            number=number,
            work_type=work_type,
            status=status,
        )
    await _repeat(
        database,
        data,
        equipment_id=ppr_hit.equipment_id,
        fault_code_id=data["fault"],
        issued_at=closed_ppr.closed_at + timedelta(days=1),
        number="OUTCOME-PPR-REPEAT",
        executor_id=data["master"].employee_id,
    )
    for index in range(20):
        await _repeat(
            database,
            data,
            equipment_id=ppr_hit.equipment_id,
            fault_code_id=data["fault"],
            issued_at=closed_ppr.closed_at + timedelta(days=2, minutes=index),
            number=f"OUTCOME-PPR-{index:02}",
            executor_id=data["master"].employee_id,
        )
    malformed_source = await _malformed_prevention(database, data, issued_at=base)
    unreadable_source, missing_id = await _unreadable_lineage(database, data, issued_at=base)
    query = AnalyticsQuery(
        period="custom",
        **{"from": base - timedelta(days=1), "to": base + timedelta(days=1)},
        timezone="UTC",
    )
    view = await prevention_outcomes(
        database, data["master"], query, now=base + timedelta(days=18), limit=10
    )
    by_id = {item.order_id: item for item in view.items}
    assert by_id[repeat_hit.id].outcome == "repeat_detected"
    assert by_id[repeat_hit.id].observation is not None
    assert by_id[repeat_hit.id].observation.repeat_count == 1
    assert by_id[repeat_hit.id].observation.repeat_orders[0].number == "OUTCOME-REPEAT"
    assert by_id[repeat_hit.id].observation.repeat_orders[0].description
    assert by_id[ppr_hit.id].source is not None
    assert by_id[ppr_hit.id].source.comparison_kind == "any_unplanned"
    assert by_id[ppr_hit.id].description == ppr_hit.description
    assert all(item.description for item in by_id[ppr_hit.id].source.evidence_orders)
    assert by_id[ppr_hit.id].outcome == "repeat_detected"
    assert by_id[ppr_hit.id].observation is not None
    assert by_id[ppr_hit.id].observation.repeat_count == 21
    assert by_id[ppr_hit.id].observation.repeat_evidence_truncated
    assert by_id[no_repeat.id].outcome == "window_completed_no_recorded_repeat"
    assert by_id[pending.id].outcome == "pending"
    assert by_id[cancelled.id].outcome == "cancelled"
    assert by_id[invalid_close.id].outcome == "unknown"
    assert by_id[invalid_close.id].observation is None
    assert by_id[malformed_source.id].outcome == "unknown"
    assert by_id[malformed_source.id].source is None
    assert by_id[unreadable_source.id].outcome == "unknown"
    assert by_id[unreadable_source.id].source is None
    serialized = view.model_dump_json()
    assert str(data["foreign_equipment"]) not in serialized
    assert str(missing_id) not in serialized
    filtered = await prevention_outcomes(
        database,
        data["master"],
        query.model_copy(
            update={"executor_ids": (data["executor_id"],), "brigade_ids": (brigade_id,)}
        ),
        now=base + timedelta(days=18),
        limit=10,
    )
    filtered_ppr = next(item for item in filtered.items if item.order_id == ppr_hit.id)
    assert filtered_ppr.observation is not None
    assert filtered_ppr.observation.repeat_count == 21

    async with _client(database, tmp_path) as client:
        master = await _headers(client, data["master_login"])
        manager = await _headers(client, data["manager_login"])
        executor = await _headers(client, data["executor_login"])
        params = {
            "period": "custom",
            "from": (base - timedelta(days=1)).isoformat(),
            "to": (base + timedelta(days=1)).isoformat(),
            "timezone": "UTC",
            "limit": 5,
        }
        response = await client.get(
            "/api/v1/analytics/prevention-outcomes", params=params, headers=master
        )
        assert response.status_code == 200, response.text
        assert response.json()["total"] == 8
        assert response.json()["items"]
        assert (
            await client.get(
                "/api/v1/analytics/prevention-outcomes", params=params, headers=manager
            )
        ).status_code == 200
        assert (
            await client.get(
                "/api/v1/analytics/prevention-outcomes", params=params, headers=executor
            )
        ).status_code == 403
        foreign = await client.get(
            "/api/v1/analytics/prevention-outcomes",
            params=params | {"area_id": str(data["foreign_equipment"])},
            headers=master,
        )
        assert foreign.status_code == 404

    async with database.sessions() as session:
        assert await session.scalar(select(WorkOrder).where(WorkOrder.id == repeat_hit.id))
