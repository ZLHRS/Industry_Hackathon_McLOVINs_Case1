"""Real PostgreSQL checks for durable notification policy and outbox fanout."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from naryadai.application.notification_engine import (
    NotificationPolicy,
    process_outbox,
    scan_deadlines,
)
from naryadai.domain.lifecycle import ActorRole, WorkOrderStatus
from naryadai.infrastructure.models import (
    Area,
    Employee,
    EmployeeArea,
    Equipment,
    Notification,
    OutboxEvent,
    Priority,
    RealtimeRevision,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

pytestmark = pytest.mark.asyncio


async def _order(
    database,
    *,
    status: WorkOrderStatus,
    deadline: datetime,
    priority: Priority = Priority.NORMAL,
):
    suffix = uuid4().hex[:10]
    issued_at = min(datetime.now(UTC) - timedelta(minutes=1), deadline - timedelta(minutes=1))
    started_at = issued_at if status is WorkOrderStatus.COMPLETED else None
    completed_at = issued_at if status is WorkOrderStatus.COMPLETED else None
    async with database.sessions.begin() as session:
        area = Area(code=f"N{suffix[:7]}", name="Notification area")
        session.add(area)
        await session.flush()
        executor = Employee(
            login=f"notify-executor-{suffix}",
            display_name="Executor",
            role="executor",
            specialty="mechanic",
            grade=3,
            password_hash="x",
        )
        master = Employee(
            login=f"notify-master-{suffix}",
            display_name="Master",
            role="master",
            specialty="mechanic",
            grade=4,
            password_hash="x",
        )
        manager = Employee(
            login=f"notify-manager-{suffix}",
            display_name="Manager",
            role="manager",
            specialty="mechanic",
            grade=4,
            password_hash="x",
        )
        session.add_all([executor, master, manager])
        await session.flush()
        session.add_all(
            EmployeeArea(employee_id=employee.id, area_id=area.id)
            for employee in (executor, master, manager)
        )
        equipment = Equipment(
            inventory_number=f"NOTIFY-{suffix}",
            name="Notification pump",
            area_id=area.id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        order = WorkOrder(
            number=f"NOTIFY-{suffix}",
            work_type=WorkType.UNPLANNED,
            description="Notification policy fixture",
            area_id=area.id,
            equipment_id=equipment.id,
            executor_id=executor.id,
            master_id=master.id,
            priority=priority,
            status=status,
            issued_at=issued_at,
            deadline=deadline,
            started_at=started_at,
            completed_at=completed_at,
            attempt=1,
            version=1,
        )
        session.add(order)
        await session.flush()
        return order.id, executor.id, master.id, manager.id


async def test_deadline_scan_deduplicates_and_suppresses_completed(database):
    now = datetime.now(UTC)
    order_id, executor_id, master_id, manager_id = await _order(
        database, status=WorkOrderStatus.ISSUED, deadline=now - timedelta(minutes=61)
    )
    policy = NotificationPolicy(overdue_repeat_minutes=30, manager_escalation_minutes=60)
    assert await scan_deadlines(database, now=now, policy=policy) >= 3
    assert await scan_deadlines(database, now=now, policy=policy) == 0
    async with database.sessions() as session:
        rows = list(
            (
                await session.scalars(
                    select(Notification).where(Notification.work_order_id == order_id)
                )
            ).all()
        )
        assert {row.employee_id for row in rows} >= {executor_id, master_id, manager_id}
        assert any(row.kind == "overdue" for row in rows)

    completed_id, *_ = await _order(
        database, status=WorkOrderStatus.COMPLETED, deadline=now - timedelta(hours=2)
    )
    assert await scan_deadlines(database, now=now, policy=policy) == 0
    async with database.sessions() as session:
        assert (
            await session.scalar(
                select(Notification.id).where(Notification.work_order_id == completed_id)
            )
            is None
        )


async def test_outbox_fanout_marks_current_event_once_and_bumps_revision(database):
    now = datetime.now(UTC)
    order_id, executor_id, master_id, manager_id = await _order(
        database, status=WorkOrderStatus.ISSUED, deadline=now + timedelta(hours=1)
    )
    async with database.sessions.begin() as session:
        event = WorkOrderEvent(
            id=uuid4(),
            work_order_id=order_id,
            sequence=1,
            order_version=1,
            actor_id=executor_id,
            actor_role=ActorRole.EXECUTOR,
            action="issue",
            from_status=None,
            to_status=WorkOrderStatus.ISSUED,
            occurred_at=now,
            details={"attempt": 1},
        )
        session.add(event)
        await session.flush()
        session.add(
            OutboxEvent(
                id=uuid4(),
                work_order_id=order_id,
                event_id=event.id,
                event_type="work_order.issue",
                payload={},
                created_at=now,
            )
        )
    assert await process_outbox(database, now=now) == 1
    assert await process_outbox(database, now=now) == 0
    async with database.sessions() as session:
        notification = await session.scalar(
            select(Notification).where(
                Notification.work_order_id == order_id,
                Notification.employee_id == executor_id,
            )
        )
        revisions = dict(
            (
                await session.execute(
                    select(RealtimeRevision.employee_id, RealtimeRevision.revision).where(
                        RealtimeRevision.employee_id.in_((executor_id, master_id, manager_id))
                    )
                )
            ).all()
        )
        assert notification is not None
        assert notification.kind == "assignment"
        assert revisions == {executor_id: 1, master_id: 1, manager_id: 1}


async def test_reassignment_restarts_acceptance_timer_and_stale_outbox_is_suppressed(database):
    now = datetime.now(UTC)
    order_id, executor_id, master_id, _manager_id = await _order(
        database, status=WorkOrderStatus.ISSUED, deadline=now + timedelta(hours=1)
    )
    async with database.sessions.begin() as session:
        order = await session.get(WorkOrder, order_id, with_for_update=True)
        assert order is not None
        event = WorkOrderEvent(
            id=uuid4(),
            work_order_id=order_id,
            sequence=1,
            order_version=2,
            actor_id=master_id,
            actor_role=ActorRole.MASTER,
            action="reassign",
            from_status=WorkOrderStatus.ISSUED,
            to_status=WorkOrderStatus.ISSUED,
            occurred_at=now - timedelta(minutes=1),
            details={"attempt": 1, "previous_executor_id": str(executor_id)},
        )
        session.add(event)
        await session.flush()
        session.add(
            OutboxEvent(
                id=uuid4(),
                work_order_id=order_id,
                event_id=event.id,
                event_type="work_order.reassign",
                payload={},
                created_at=now,
            )
        )
    policy = NotificationPolicy(acceptance_minutes=10)
    assert await scan_deadlines(database, now=now, policy=policy) == 0
    assert await process_outbox(database, now=now) == 1
    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(Notification)) == 1


async def test_concurrent_outbox_workers_fan_out_only_once(database):
    now = datetime.now(UTC)
    order_id, executor_id, _master_id, _manager_id = await _order(
        database, status=WorkOrderStatus.ISSUED, deadline=now + timedelta(hours=1)
    )
    async with database.sessions.begin() as session:
        event = WorkOrderEvent(
            id=uuid4(),
            work_order_id=order_id,
            sequence=1,
            order_version=1,
            actor_id=executor_id,
            actor_role=ActorRole.EXECUTOR,
            action="issue",
            from_status=None,
            to_status=WorkOrderStatus.ISSUED,
            occurred_at=now,
            details={"attempt": 1},
        )
        session.add(event)
        await session.flush()
        session.add(
            OutboxEvent(
                id=uuid4(),
                work_order_id=order_id,
                event_id=event.id,
                event_type="work_order.issue",
                payload={},
                created_at=now,
            )
        )

    first, second = await asyncio.gather(
        process_outbox(database, now=now),
        process_outbox(database, now=now),
    )
    assert sorted((first, second)) == [0, 1]
    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(Notification)) == 1


async def test_acceptance_advisory_excludes_candidate_and_reassignment_resets_timer(database):
    now = datetime.now(UTC)
    order_id, executor_id, master_id, _manager_id = await _order(
        database, status=WorkOrderStatus.ISSUED, deadline=now + timedelta(hours=1)
    )
    async with database.sessions.begin() as session:
        order = await session.get(WorkOrder, order_id, with_for_update=True)
        assert order is not None
        candidate = Employee(
            login=f"candidate-{uuid4().hex[:10]}",
            display_name="Свободный исполнитель",
            role="executor",
            specialty="mechanic",
            grade=3,
            password_hash="x",
        )
        session.add(candidate)
        await session.flush()
        session.add(EmployeeArea(employee_id=candidate.id, area_id=order.area_id))
        order.issued_at = now - timedelta(minutes=11)

    policy = NotificationPolicy(acceptance_minutes=10)
    assert await scan_deadlines(database, now=now, policy=policy) == 1
    async with database.sessions() as session:
        notifications = list(
            (
                await session.scalars(
                    select(Notification).where(Notification.work_order_id == order_id)
                )
            ).all()
        )
        assert [notification.employee_id for notification in notifications] == [master_id]
        assert notifications[0].payload["candidate_id"] != str(executor_id)
        assert notifications[0].payload["candidate_name"] == "Свободный исполнитель"

    async with database.sessions.begin() as session:
        order = await session.get(WorkOrder, order_id, with_for_update=True)
        assert order is not None
        order.attempt = 2
        session.add(
            WorkOrderEvent(
                id=uuid4(),
                work_order_id=order_id,
                sequence=1,
                order_version=2,
                actor_id=master_id,
                actor_role=ActorRole.MASTER,
                action="reassign",
                from_status=WorkOrderStatus.ISSUED,
                to_status=WorkOrderStatus.ISSUED,
                occurred_at=now - timedelta(minutes=1),
                details={"attempt": 2, "previous_executor_id": str(executor_id)},
            )
        )
    assert await scan_deadlines(database, now=now, policy=policy) == 0
    assert await scan_deadlines(database, now=now + timedelta(minutes=10), policy=policy) == 1


async def test_stale_issue_does_not_notify_completed_order_but_bumps_viewers(database):
    now = datetime.now(UTC)
    order_id, executor_id, master_id, manager_id = await _order(
        database, status=WorkOrderStatus.COMPLETED, deadline=now - timedelta(minutes=1)
    )
    async with database.sessions.begin() as session:
        event = WorkOrderEvent(
            id=uuid4(),
            work_order_id=order_id,
            sequence=1,
            order_version=1,
            actor_id=executor_id,
            actor_role=ActorRole.EXECUTOR,
            action="issue",
            from_status=None,
            to_status=WorkOrderStatus.ISSUED,
            occurred_at=now - timedelta(minutes=2),
            details={"attempt": 1},
        )
        session.add(event)
        await session.flush()
        session.add(
            OutboxEvent(
                id=uuid4(),
                work_order_id=order_id,
                event_id=event.id,
                event_type="work_order.issue",
                payload={},
                created_at=now,
            )
        )
    assert await process_outbox(database, now=now) == 0
    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(Notification)) == 0
        assert (
            await session.scalar(
                select(func.count())
                .select_from(RealtimeRevision)
                .where(RealtimeRevision.employee_id.in_((executor_id, master_id, manager_id)))
            )
            == 3
        )
