"""Analytics event-history regressions against PostgreSQL."""

from datetime import UTC, datetime

import pytest

from naryadai.analytics.contracts import AnalyticsQuery
from naryadai.analytics.service import build_report
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import ActorRole, WorkOrderStatus
from naryadai.infrastructure.models import (
    Area,
    Employee,
    Equipment,
    Priority,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)


def at(hour: int, day: int = 1) -> datetime:
    return datetime(2026, 6, day, hour, tzinfo=UTC)


def principal(employee: Employee, area: Area) -> Principal:
    return Principal(
        employee.id, employee.id, employee.login, employee.display_name, "master", (area.id,)
    )


@pytest.mark.asyncio
async def test_report_excludes_legacy_rework_blame_and_measures_reassigned_response(
    database,
) -> None:
    async with database.sessions.begin() as session:
        area = Area(code="AE", name="Analytics edge")
        session.add(area)
        await session.flush()
        master = Employee(
            login="edge_master",
            display_name="Master",
            role="master",
            specialty="mechanic",
            grade=5,
            password_hash="x",
        )
        returned = Employee(
            login="edge_returned",
            display_name="Returned",
            role="executor",
            specialty="mechanic",
            grade=4,
            password_hash="x",
        )
        peer = Employee(
            login="edge_peer",
            display_name="Peer",
            role="executor",
            specialty="mechanic",
            grade=4,
            password_hash="x",
        )
        session.add_all((master, returned, peer))
        await session.flush()
        equipment = Equipment(
            inventory_number="AN-EDGE",
            name="Pump",
            area_id=area.id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()

        def closed(number: str, executor: Employee, attempt: int) -> WorkOrder:
            return WorkOrder(
                number=number,
                work_type=WorkType.UNPLANNED,
                description=number,
                area_id=area.id,
                equipment_id=equipment.id,
                executor_id=executor.id,
                master_id=master.id,
                priority=Priority.NORMAL,
                status=WorkOrderStatus.CLOSED,
                issued_at=at(8),
                started_at=at(8),
                completed_at=at(10),
                closed_at=at(11),
                deadline=at(12),
                attempt=attempt,
            )

        returned_orders = [closed(f"AE-R{index}", returned, 2) for index in range(5)]
        peer_orders = [closed(f"AE-P{index}", peer, 1) for index in range(5)]
        reaction_order = WorkOrder(
            number="AE-REACTION",
            work_type=WorkType.UNPLANNED,
            description="reaction",
            area_id=area.id,
            equipment_id=equipment.id,
            executor_id=peer.id,
            master_id=master.id,
            priority=Priority.NORMAL,
            status=WorkOrderStatus.ACCEPTED,
            issued_at=at(8),
            deadline=at(18),
        )
        session.add_all([*returned_orders, *peer_orders, reaction_order])
        await session.flush()
        session.add_all(
            (
                WorkOrderEvent(
                    work_order_id=reaction_order.id,
                    sequence=1,
                    order_version=1,
                    action="accept",
                    occurred_at=at(9),
                    actor_id=returned.id,
                    actor_role=ActorRole.EXECUTOR,
                    to_status=WorkOrderStatus.ACCEPTED,
                    details={},
                ),
                WorkOrderEvent(
                    work_order_id=reaction_order.id,
                    sequence=2,
                    order_version=2,
                    action="reassign",
                    occurred_at=at(10),
                    actor_id=master.id,
                    actor_role=ActorRole.MASTER,
                    to_status=WorkOrderStatus.ISSUED,
                    details={"previous_executor_id": str(returned.id), "executor_id": str(peer.id)},
                ),
                WorkOrderEvent(
                    work_order_id=reaction_order.id,
                    sequence=3,
                    order_version=3,
                    action="accept",
                    occurred_at=at(10, day=1).replace(minute=30),
                    actor_id=peer.id,
                    actor_role=ActorRole.EXECUTOR,
                    to_status=WorkOrderStatus.ACCEPTED,
                    details={},
                ),
                WorkOrderEvent(
                    work_order_id=reaction_order.id,
                    sequence=4,
                    order_version=4,
                    action="reassign",
                    occurred_at=at(12),
                    actor_id=master.id,
                    actor_role=ActorRole.MASTER,
                    to_status=WorkOrderStatus.ISSUED,
                    details={"previous_executor_id": str(peer.id), "executor_id": str(peer.id)},
                ),
                WorkOrderEvent(
                    work_order_id=reaction_order.id,
                    sequence=5,
                    order_version=5,
                    action="accept",
                    occurred_at=at(0, day=2),
                    actor_id=peer.id,
                    actor_role=ActorRole.EXECUTOR,
                    to_status=WorkOrderStatus.ACCEPTED,
                    details={},
                ),
            )
        )

    report = await build_report(
        database,
        principal(master, area),
        AnalyticsQuery(period="custom", **{"from": at(8), "to": at(0, day=2)}, timezone="UTC"),
        now=at(0, day=20),
    )
    returned_rating = next(row for row in report.ratings.employees if row.subject_id == returned.id)
    assert returned_rating.components["rework"].numerator == 0
    assert returned_rating.components["rework"].denominator == 0
    assert returned_rating.components["rework"].value is None
    assert any(
        "не влияют на персональный показатель" in item for item in report.ratings.limitations
    )
    concentration = [row for row in report.anomalies if row.family == "rework_concentration"]
    assert concentration == []
    assert report.durations.sample_sizes["response"] == 2
    assert report.durations.response_seconds == 2700
