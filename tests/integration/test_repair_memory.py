"""HTTP acceptance checks for bounded, master-accepted repair memory."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from naryadai.domain.lifecycle import ActorRole, WorkOrderStatus
from naryadai.infrastructure.models import (
    Equipment,
    MaterialUsage,
    Priority,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

pytestmark = pytest.mark.asyncio
pytest_plugins = ("test_order_api",)


async def _closed(
    database,
    api,
    *,
    number: str,
    closed_at: datetime,
    equipment_id,
    fault_id,
    description: str = "Утечка масла из сальника",
    work_description: str = "Заменили сальник и проверили герметичность.",
    attempt: int = 1,
    close_submission: int | None = 5,
    last_submission: int | None = 5,
    close_action: str = "close",
    close_actor_role: ActorRole = ActorRole.MASTER,
    close_actor_id=None,
) -> WorkOrder:
    async with database.sessions.begin() as session:
        order = WorkOrder(
            number=number,
            work_type=WorkType.UNPLANNED,
            description=description,
            area_id=api["areas"][0].id,
            equipment_id=equipment_id,
            executor_id=api["users"]["executor"],
            master_id=api["users"]["master"],
            priority=Priority.HIGH,
            status=WorkOrderStatus.CLOSED,
            issued_at=closed_at - timedelta(hours=2),
            deadline=closed_at - timedelta(hours=1),
            started_at=closed_at - timedelta(hours=1, minutes=30),
            completed_at=closed_at - timedelta(minutes=30),
            closed_at=closed_at,
            fault_code_id=fault_id,
            work_description=work_description,
            version=6,
            attempt=attempt,
            last_submission_version=last_submission,
        )
        session.add(order)
        await session.flush()
        details = {} if close_submission is None else {"submission_version": close_submission}
        session.add_all(
            (
                WorkOrderEvent(
                    work_order_id=order.id,
                    sequence=1,
                    order_version=5,
                    actor_id=api["users"]["executor"],
                    actor_role=ActorRole.EXECUTOR,
                    action="complete",
                    from_status=WorkOrderStatus.IN_PROGRESS,
                    to_status=WorkOrderStatus.COMPLETED,
                    occurred_at=closed_at - timedelta(minutes=30),
                    details={"submission_version": last_submission},
                ),
                WorkOrderEvent(
                    work_order_id=order.id,
                    sequence=2,
                    order_version=6,
                    actor_id=close_actor_id
                    or (
                        api["users"]["master"]
                        if close_actor_role is ActorRole.MASTER
                        else api["users"]["executor"]
                    ),
                    actor_role=close_actor_role,
                    action=close_action,
                    from_status=WorkOrderStatus.AI_REVIEW,
                    to_status=WorkOrderStatus.CLOSED,
                    occurred_at=closed_at,
                    details=details,
                ),
            )
        )
        return order


async def test_similar_repairs_are_scoped_ranked_and_use_final_master_closed_evidence(
    api, database
):
    now = datetime.now(UTC).replace(microsecond=0)
    async with database.sessions.begin() as session:
        fault = api["fault"]
        material = api["material"]
        compatible = Equipment(
            inventory_number="MEM-COMPAT",
            name="Compatible pump",
            area_id=api["areas"][0].id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(compatible)
        await session.flush()
        compatible_id = compatible.id

    newest = await _closed(
        database, api, number="MEM-NEW", closed_at=now - timedelta(days=2),
        equipment_id=api["machines"][0].id, fault_id=fault.id,
    )
    middle = await _closed(
        database, api, number="MEM-MID", closed_at=now - timedelta(days=4),
        equipment_id=api["machines"][0].id, fault_id=fault.id,
    )
    oldest = await _closed(
        database, api, number="MEM-OLD", closed_at=now - timedelta(days=10),
        equipment_id=api["machines"][0].id, fault_id=fault.id,
    )
    await _closed(
        database, api, number="MEM-COMPAT", closed_at=now - timedelta(days=1),
        equipment_id=compatible_id, fault_id=fault.id,
    )
    unsafe = await _closed(
        database, api, number="MEM-STALE", closed_at=now - timedelta(days=3),
        equipment_id=api["machines"][0].id, fault_id=fault.id, attempt=2,
        close_submission=4, last_submission=5,
    )
    async with database.sessions.begin() as session:
        session.add_all(
            (
                MaterialUsage(
                    work_order_id=middle.id,
                    material_id=material.id,
                    quantity="1.000",
                    submission_version=4,
                ),
                MaterialUsage(
                    work_order_id=middle.id,
                    material_id=material.id,
                    quantity="2.000",
                    submission_version=5,
                ),
                WorkOrder(
                    number="MEM-REPEAT",
                    work_type=WorkType.UNPLANNED,
                    description="later",
                    area_id=api["areas"][0].id,
                    equipment_id=oldest.equipment_id,
                    executor_id=api["users"]["executor"],
                    master_id=api["users"]["master"],
                    priority=Priority.HIGH,
                    status=WorkOrderStatus.ISSUED,
                    issued_at=oldest.closed_at + timedelta(days=7),
                    deadline=now + timedelta(days=1),
                    fault_code_id=fault.id,
                    version=1,
                    attempt=1,
                ),
            WorkOrder(
                number="MEM-FUTURE",
                work_type=WorkType.UNPLANNED,
                description="future repeat",
                area_id=api["areas"][0].id,
                equipment_id=oldest.equipment_id,
                executor_id=api["users"]["executor"],
                master_id=api["users"]["master"],
                priority=Priority.HIGH,
                status=WorkOrderStatus.ISSUED,
                issued_at=now + timedelta(days=1),
                deadline=now + timedelta(days=2),
                fault_code_id=fault.id,
                version=1,
                attempt=1,
            ),
            )
        )

    body = {
        "area_id": str(api["areas"][0].id),
        "equipment_id": str(api["machines"][0].id),
        "description": "Утечка масла из сальника",
        "fault_code_id": str(fault.id),
    }
    response = await api["client"].post(
        "/api/v1/work-orders/similar-repairs", json=body, headers=api["headers"]["master"]
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert [item["number"] for item in result["items"]] == ["MEM-NEW", "MEM-MID", "MEM-OLD"]
    assert all(item["number"] != unsafe.number for item in result["items"])
    assert result["items"][1]["materials"] == [
        {"material_id": str(material.id), "code": material.code, "name": material.name,
         "unit": material.unit, "quantity": "2.000"}
    ]
    assert result["items"][0]["followup"]["status"] == "observing"
    assert result["items"][2]["followup"]["status"] == "observed_repeat"
    # The exact seven-day boundary counts; the deliberately future record does not.
    assert result["items"][2]["followup"]["repeat_count"] == 3
    assert result["items"][0]["followup"]["repeat_count"] == 0
    assert result["items"][0]["match"]["reason_codes"] == ["same_equipment", "same_fault_code"]

    generic = await api["client"].post(
        "/api/v1/work-orders/similar-repairs",
        json=body | {"fault_code_id": None, "description": "проверка насоса ДЕМО"},
        headers=api["headers"]["master"],
    )
    assert generic.status_code == 200 and generic.json()["items"] == []
    verbs_only = await api["client"].post(
        "/api/v1/work-orders/similar-repairs",
        json=body | {"fault_code_id": None, "description": "Проверить оборудование"},
        headers=api["headers"]["master"],
    )
    assert verbs_only.status_code == 200 and verbs_only.json()["items"] == []
    by_text = await api["client"].post(
        "/api/v1/work-orders/similar-repairs",
        json=body | {"fault_code_id": None, "description": "утечка"},
        headers=api["headers"]["master"],
    )
    assert by_text.status_code == 200 and by_text.json()["items"]
    for role in ("executor", "manager", "admin"):
        assert (
            await api["client"].post(
                "/api/v1/work-orders/similar-repairs", json=body, headers=api["headers"][role]
            )
        ).status_code == 403
    assert (
        await api["client"].post(
            "/api/v1/work-orders/similar-repairs", json=body, headers=api["headers"]["foreign"]
        )
    ).status_code == 404

    async with database.sessions() as session:
        assert await session.get(WorkOrder, newest.id)
        assert await session.scalar(select(WorkOrder).where(WorkOrder.id == unsafe.id))


async def test_similar_repairs_require_traceable_master_closure_and_active_selection(api, database):
    now = datetime.now(UTC).replace(microsecond=0)
    fault = api["fault"]
    material = api["material"]
    override = await _closed(
        database,
        api,
        number="MEM-OVERRIDE",
        closed_at=now - timedelta(days=8),
        equipment_id=api["machines"][0].id,
        fault_id=fault.id,
        close_action="override_close",
    )
    legacy = await _closed(
        database,
        api,
        number="MEM-LEGACY",
        closed_at=now - timedelta(days=9),
        equipment_id=api["machines"][0].id,
        fault_id=fault.id,
        close_submission=None,
        last_submission=1,
    )
    await _closed(
        database,
        api,
        number="MEM-NONMASTER",
        closed_at=now - timedelta(days=7),
        equipment_id=api["machines"][0].id,
        fault_id=fault.id,
        close_actor_role=ActorRole.EXECUTOR,
    )
    async with database.sessions.begin() as session:
        session.add(
            MaterialUsage(
                work_order_id=legacy.id,
                material_id=material.id,
                quantity="3.000",
                submission_version=None,
            )
        )

    body = {
        "area_id": str(api["areas"][0].id),
        "equipment_id": str(api["machines"][0].id),
        "description": "Утечка масла из сальника",
        "fault_code_id": str(fault.id),
    }
    async with database.sessions() as session:
        before_events = await session.scalar(select(func.count()).select_from(WorkOrderEvent))
    response = await api["client"].post(
        "/api/v1/work-orders/similar-repairs", json=body, headers=api["headers"]["master"]
    )
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [item["number"] for item in items] == ["MEM-OVERRIDE", "MEM-LEGACY"]
    assert items[1]["materials"] == [
        {
            "material_id": str(material.id),
            "code": material.code,
            "name": material.name,
            "unit": material.unit,
            "quantity": "3.000",
        }
    ]
    assert items[0]["order_id"] == str(override.id)
    async with database.sessions() as session:
        after_events = await session.scalar(select(func.count()).select_from(WorkOrderEvent))
    assert after_events == before_events

    async with database.sessions.begin() as session:
        equipment = await session.get(Equipment, api["machines"][0].id)
        assert equipment is not None
        equipment.is_active = False
    inactive_equipment = await api["client"].post(
        "/api/v1/work-orders/similar-repairs", json=body, headers=api["headers"]["master"]
    )
    assert inactive_equipment.status_code == 409
    async with database.sessions.begin() as session:
        equipment = await session.get(Equipment, api["machines"][0].id)
        area = await session.get(type(api["areas"][0]), api["areas"][0].id)
        assert equipment is not None and area is not None
        equipment.is_active = True
        area.is_active = False
    inactive_area = await api["client"].post(
        "/api/v1/work-orders/similar-repairs", json=body, headers=api["headers"]["master"]
    )
    assert inactive_area.status_code == 409
