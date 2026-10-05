from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from naryadai.infrastructure.models import Area, Employee, Equipment, WorkOrder, WorkOrderEvent

pytestmark = pytest.mark.asyncio


async def test_database_connection_preserves_isolated_schema_and_server_timeouts(database) -> None:
    async with database.engine.connect() as connection:
        search_path = await connection.scalar(text("SHOW search_path"))
        statement_timeout = await connection.scalar(text("SHOW statement_timeout"))
        lock_timeout = await connection.scalar(text("SHOW lock_timeout"))

    assert str(search_path).startswith("test_")
    assert str(statement_timeout) in {"30s", "30000ms"}
    assert str(lock_timeout) in {"5s", "5000ms"}


async def test_postgresql_constraints_reject_invalid_equipment_and_cross_area_order(
    database,
) -> None:
    async with database.sessions.begin() as session:
        first = Area(code="A1", name="First area")
        second = Area(code="A2", name="Second area")
        master = Employee(
            login="master",
            display_name="Master",
            role="master",
            specialty="mechanic",
            grade=5,
            password_hash="hash",
        )
        executor = Employee(
            login="executor",
            display_name="Executor",
            role="executor",
            specialty="mechanic",
            grade=3,
            password_hash="hash",
        )
        session.add_all([first, second, master, executor])
        await session.flush()
        equipment = Equipment(
            inventory_number="PUMP-1",
            name="Pump",
            area_id=first.id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()

    async with database.sessions.begin() as session:
        session.add(
            WorkOrder(
                number="WO-1",
                work_type="unplanned",
                description="Repair pump",
                area_id=second.id,
                equipment_id=equipment.id,
                executor_id=executor.id,
                master_id=master.id,
                priority="high",
                status="issued",
                deadline=datetime.now(UTC) + timedelta(hours=1),
            )
        )
        with pytest.raises(IntegrityError):
            await session.flush()
        await session.rollback()

    async with database.sessions.begin() as session:
        session.add(
            Equipment(
                inventory_number="PUMP-2",
                name="Invalid",
                area_id=first.id,
                equipment_type="pump",
                criticality=6,
            )
        )
        with pytest.raises(IntegrityError):
            await session.flush()
        await session.rollback()


async def test_uuid_primary_keys_are_generated_by_orm(database) -> None:
    area = Area(code="UUID", name="UUID area")
    async with database.sessions.begin() as session:
        session.add(area)
        await session.flush()

    assert area.id != uuid4()


async def _order_references(database):
    async with database.sessions.begin() as session:
        area = Area(code="TIME", name="Time area")
        master = Employee(
            login="time-master",
            display_name="Master",
            role="master",
            specialty="mechanic",
            grade=5,
            password_hash="hash",
        )
        executor = Employee(
            login="time-executor",
            display_name="Executor",
            role="executor",
            specialty="mechanic",
            grade=3,
            password_hash="hash",
        )
        session.add_all([area, master, executor])
        await session.flush()
        equipment = Equipment(
            inventory_number="TIME-PUMP",
            name="Pump",
            area_id=area.id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        return area.id, equipment.id, executor.id, master.id


def _work_order(area_id, equipment_id, executor_id, master_id, **overrides):
    issued_at = datetime(2026, 10, 5, 9, tzinfo=UTC)
    values = {
        "number": "WO-" + uuid4().hex,
        "work_type": "unplanned",
        "description": "Repair pump",
        "area_id": area_id,
        "equipment_id": equipment_id,
        "executor_id": executor_id,
        "master_id": master_id,
        "priority": "high",
        "status": "issued",
        "issued_at": issued_at,
        "deadline": issued_at + timedelta(hours=1),
    }
    values.update(overrides)
    return WorkOrder(**values)


async def test_active_order_allows_null_timestamps_and_persists_lowercase_event(database):
    references = await _order_references(database)
    async with database.sessions.begin() as session:
        order = _work_order(*references)
        session.add(order)
        await session.flush()
        session.add(
            WorkOrderEvent(
                work_order_id=order.id,
                sequence=1,
                actor_id=None,
                actor_role="system",
                action="issue",
                from_status=None,
                to_status="issued",
            )
        )
        await session.flush()
        role = await session.scalar(text("SELECT actor_role FROM work_order_events"))
        action = await session.scalar(text("SELECT action FROM work_order_events"))

    assert (order.started_at, order.completed_at, order.closed_at) == (None, None, None)
    assert (role, action) == ("system", "issue")


@pytest.mark.parametrize(
    "overrides",
    [
        {"started_at": datetime(2026, 10, 5, 8, 59, tzinfo=UTC)},
        {"completed_at": datetime(2026, 10, 5, 9, 10, tzinfo=UTC)},
        {
            "started_at": datetime(2026, 10, 5, 9, 10, tzinfo=UTC),
            "completed_at": datetime(2026, 10, 5, 9, 20, tzinfo=UTC),
            "closed_at": datetime(2026, 10, 5, 9, 19, tzinfo=UTC),
            "status": "closed",
        },
        {"status": "closed"},
    ],
)
async def test_work_order_rejects_impossible_timestamp_sequences(database, overrides):
    references = await _order_references(database)
    async with database.sessions() as session:
        session.add(_work_order(*references, **overrides))
        with pytest.raises(IntegrityError):
            await session.flush()
        await session.rollback()


async def test_server_timeouts_survive_reused_connection_rollbacks(database):
    async with database.engine.connect() as connection:
        backend_pid = await connection.scalar(text("SELECT pg_backend_pid()"))
        await connection.execute(text("SELECT 1"))
        await connection.rollback()

    async with database.engine.connect() as connection:
        assert await connection.scalar(text("SELECT pg_backend_pid()")) == backend_pid
        assert await connection.scalar(text("SHOW statement_timeout")) in {"30s", "30000ms"}
        assert await connection.scalar(text("SHOW lock_timeout")) in {"5s", "5000ms"}

    async with database.sessions() as session:
        session.add(
            Equipment(
                inventory_number="TIMEOUT-INVALID",
                name="Invalid",
                area_id=uuid4(),
                equipment_type="pump",
                criticality=6,
            )
        )
        with pytest.raises(IntegrityError):
            await session.flush()
        await session.rollback()

    async with database.engine.connect() as connection:
        assert await connection.scalar(text("SHOW statement_timeout")) in {"30s", "30000ms"}
        assert await connection.scalar(text("SHOW lock_timeout")) in {"5s", "5000ms"}
