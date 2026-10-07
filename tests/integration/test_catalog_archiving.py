"""Archive controls preserve history while blocking new operational use."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx2 import ASGITransport, AsyncClient
from sqlalchemy import select
from test_auth import app_for, bearer, people, token

from naryadai.infrastructure.models import (
    Area,
    Brigade,
    Employee,
    Equipment,
    FaultCode,
    Material,
    MaterialUsage,
    TimeNorm,
    WorkOrder,
)

pytestmark = pytest.mark.asyncio


def order_body(area_id, equipment_id, executor_id):
    return {
        "work_type": "unplanned",
        "description": "Archive control regression",
        "area_id": str(area_id),
        "equipment_id": str(equipment_id),
        "executor_id": str(executor_id),
        "priority": "normal",
        "deadline": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
    }


async def issue(client, headers, body):
    response = await client.post(
        "/api/v1/work-orders",
        json=body,
        headers=headers | {"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def cancel(client, headers, order):
    response = await client.post(
        f"/api/v1/work-orders/{order['order_id']}/actions",
        json={
            "action": "cancel",
            "expected_version": order["version"],
            "reason": "No longer needed",
        },
        headers=headers | {"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 200, response.text


async def test_catalog_archive_restore_and_employee_deactivation_guard(database):
    users, area_id, _, _ = await people(database)
    async with database.sessions.begin() as session:
        equipment = Equipment(
            inventory_number="ARCHIVE-01",
            name="Archive test pump",
            area_id=area_id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        equipment_id = equipment.id
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        master = bearer(await token(client, "master"))
        body = order_body(area_id, equipment_id, users["executor"])
        open_order = await issue(client, master, body)

        assert (
            await client.patch(
                f"/api/v1/catalog/areas/{area_id}",
                json={"is_active": False},
                headers=master,
            )
        ).status_code == 403
        for path in [
            f"/api/v1/catalog/areas/{area_id}",
            f"/api/v1/catalog/equipment/{equipment_id}",
        ]:
            response = await client.patch(path, json={"is_active": False}, headers=admin)
            assert response.status_code == 409
            assert response.json() == {"detail": "active_work_orders_exist"}

        async with database.sessions.begin() as session:
            equipment = await session.get(Equipment, equipment_id)
            assert equipment is not None
            equipment.is_active = False
        reassign = await client.post(
            f"/api/v1/work-orders/{open_order['order_id']}/actions",
            json={
                "action": "reassign",
                "expected_version": open_order["version"],
                "executor_id": str(users["executor"]),
                "reason": "Check inactive equipment",
            },
            headers=master | {"Idempotency-Key": str(uuid4())},
        )
        assert reassign.status_code == 409
        assert reassign.json() == {"detail": "equipment_inactive"}
        async with database.sessions.begin() as session:
            equipment = await session.get(Equipment, equipment_id)
            assert equipment is not None
            equipment.is_active = True

        await cancel(client, master, open_order)
        archived_equipment = await client.patch(
            f"/api/v1/catalog/equipment/{equipment_id}", json={"is_active": False}, headers=admin
        )
        assert archived_equipment.status_code == 200
        assert archived_equipment.json()["is_active"] is False
        catalog = (await client.get("/api/v1/catalog", headers=master)).json()
        catalog_equipment = next(
            item for item in catalog["equipment"] if item["id"] == str(equipment_id)
        )
        assert catalog_equipment["is_active"] is False
        history = await client.get(f"/api/v1/equipment/{equipment_id}/history", headers=master)
        assert history.status_code == 200 and history.json()["total"] == 1
        rejected_equipment = await client.post(
            "/api/v1/work-orders",
            json=body,
            headers=master | {"Idempotency-Key": str(uuid4())},
        )
        assert rejected_equipment.status_code == 409
        assert rejected_equipment.json() == {"detail": "equipment_inactive"}
        assert (
            await client.patch(
                f"/api/v1/catalog/equipment/{equipment_id}", json={"is_active": True}, headers=admin
            )
        ).json()["is_active"] is True

        archived_area = await client.patch(
            f"/api/v1/catalog/areas/{area_id}", json={"is_active": False}, headers=admin
        )
        assert archived_area.status_code == 200
        assert archived_area.json()["is_active"] is False
        rejected_area = await client.post(
            "/api/v1/work-orders",
            json=body,
            headers=master | {"Idempotency-Key": str(uuid4())},
        )
        assert rejected_area.status_code == 409
        assert rejected_area.json() == {"detail": "area_inactive"}
        assert (
            await client.patch(
                f"/api/v1/catalog/areas/{area_id}",
                json={"is_active": True},
                headers=admin,
            )
        ).json()["is_active"] is True

        second_order = await issue(client, master, body)
        deactivation = await client.patch(
            f"/api/v1/catalog/employees/{users['executor']}/access",
            json={"is_active": False},
            headers=admin,
        )
        assert deactivation.status_code == 409
        assert deactivation.json() == {"detail": "worker_has_active_order"}
        await cancel(client, master, second_order)
        deactivation = await client.patch(
            f"/api/v1/catalog/employees/{users['executor']}/access",
            json={"is_active": False},
            headers=admin,
        )
        assert deactivation.status_code == 200
        assert deactivation.json()["is_active"] is False


async def test_reassignment_rejects_inactive_area(database):
    users, area_id, _, _ = await people(database)
    async with database.sessions.begin() as session:
        equipment = Equipment(
            inventory_number="ARCHIVE-02",
            name="Archive test fan",
            area_id=area_id,
            equipment_type="fan",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        equipment_id = equipment.id
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        master = bearer(await token(client, "master"))
        order = await issue(client, master, order_body(area_id, equipment_id, users["executor"]))
        async with database.sessions.begin() as session:
            area = await session.get(Area, area_id)
            assert area is not None
            area.is_active = False
        response = await client.post(
            f"/api/v1/work-orders/{order['order_id']}/actions",
            json={
                "action": "reassign",
                "expected_version": order["version"],
                "executor_id": str(users["executor"]),
                "reason": "Check inactive area",
            },
            headers=master | {"Idempotency-Key": str(uuid4())},
        )
        assert response.status_code == 409
        assert response.json() == {"detail": "area_inactive"}


async def test_equipment_move_preserves_historical_area_scope(database):
    users, area_id, other_area_id, _ = await people(database)
    async with database.sessions.begin() as session:
        equipment = Equipment(
            inventory_number="MOVE-HISTORY",
            name="Historical pump",
            area_id=area_id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        equipment_id = equipment.id
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        master = bearer(await token(client, "master"))
        order = await issue(client, master, order_body(area_id, equipment_id, users["executor"]))
        await cancel(client, master, order)
        moved = await client.put(
            f"/api/v1/catalog/equipment/{equipment_id}",
            json={
                "inventory_number": "MOVE-HISTORY",
                "name": "Historical pump",
                "area_id": str(other_area_id),
                "equipment_type": "pump",
                "criticality": 3,
            },
            headers=admin,
        )
        assert moved.status_code == 409
        assert moved.json() == {"detail": "equipment_has_history"}
        history = await client.get(f"/api/v1/equipment/{equipment_id}/history", headers=master)
        assert history.status_code == 200 and history.json()["total"] == 1


async def test_unreferenced_equipment_moves_only_to_active_area(database):
    _, area_id, other_area_id, _ = await people(database)
    async with database.sessions.begin() as session:
        equipment = Equipment(
            inventory_number="MOVE-FREE",
            name="Unreferenced pump",
            area_id=area_id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        equipment_id = equipment.id
        other_area = await session.get(Area, other_area_id)
        assert other_area is not None
        other_area.is_active = False
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        payload = {
            "inventory_number": "MOVE-FREE",
            "name": "Unreferenced pump",
            "area_id": str(other_area_id),
            "equipment_type": "pump",
            "criticality": 3,
        }
        rejected_move = await client.put(
            f"/api/v1/catalog/equipment/{equipment_id}", json=payload, headers=admin
        )
        assert rejected_move.status_code == 409
        assert rejected_move.json() == {"detail": "area_inactive"}
        rejected_create = await client.post(
            "/api/v1/catalog/equipment",
            json=payload | {"inventory_number": "CREATE-INACTIVE"},
            headers=admin,
        )
        assert rejected_create.status_code == 409
        assert rejected_create.json() == {"detail": "area_inactive"}
        restored = await client.patch(
            f"/api/v1/catalog/areas/{other_area_id}", json={"is_active": True}, headers=admin
        )
        assert restored.status_code == 200
        moved = await client.put(
            f"/api/v1/catalog/equipment/{equipment_id}", json=payload, headers=admin
        )
        assert moved.status_code == 200
        assert moved.json()["area_id"] == str(other_area_id)


async def test_equipment_restore_requires_an_active_parent_area(database):
    _, area_id, _, _ = await people(database)
    async with database.sessions.begin() as session:
        equipment = Equipment(
            inventory_number="RESTORE-PARENT",
            name="Restore parent pump",
            area_id=area_id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        equipment_id = equipment.id
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        assert (
            await client.patch(
                f"/api/v1/catalog/equipment/{equipment_id}",
                json={"is_active": False},
                headers=admin,
            )
        ).status_code == 200
        assert (
            await client.patch(
                f"/api/v1/catalog/areas/{area_id}",
                json={"is_active": False},
                headers=admin,
            )
        ).status_code == 200
        rejected_restore = await client.patch(
            f"/api/v1/catalog/equipment/{equipment_id}",
            json={"is_active": True},
            headers=admin,
        )
        assert rejected_restore.status_code == 409
        assert rejected_restore.json() == {"detail": "area_inactive"}
        assert (
            await client.patch(
                f"/api/v1/catalog/areas/{area_id}",
                json={"is_active": True},
                headers=admin,
            )
        ).status_code == 200
        restored = await client.patch(
            f"/api/v1/catalog/equipment/{equipment_id}",
            json={"is_active": True},
            headers=admin,
        )
        assert restored.status_code == 200
        assert restored.json()["is_active"] is True


async def test_master_deactivation_requires_terminal_owned_orders(database):
    users, area_id, _, _ = await people(database)
    async with database.sessions.begin() as session:
        equipment = Equipment(
            inventory_number="MASTER-ACTIVE",
            name="Master ownership pump",
            area_id=area_id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        equipment_id = equipment.id
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        master = bearer(await token(client, "master"))
        order = await issue(client, master, order_body(area_id, equipment_id, users["executor"]))
        blocked = await client.patch(
            f"/api/v1/catalog/employees/{users['master']}/access",
            json={"is_active": False},
            headers=admin,
        )
        assert blocked.status_code == 409
        assert blocked.json() == {"detail": "worker_has_active_order"}
        await cancel(client, master, order)
        deactivated = await client.patch(
            f"/api/v1/catalog/employees/{users['master']}/access",
            json={"is_active": False},
            headers=admin,
        )
        assert deactivated.status_code == 200
        assert deactivated.json()["is_active"] is False


async def test_active_order_blocks_role_or_area_removal_but_not_additions(database):
    users, area_id, other_area_id, _ = await people(database)
    async with database.sessions.begin() as session:
        equipment = Equipment(
            inventory_number="ACCESS-ACTIVE",
            name="Access control pump",
            area_id=area_id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        equipment_id = equipment.id
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        master = bearer(await token(client, "master"))
        order = await issue(client, master, order_body(area_id, equipment_id, users["executor"]))
        for employee_id, payload in [
            (users["master"], {"role": "manager"}),
            (users["executor"], {"role": "manager"}),
            (users["master"], {"area_ids": [str(other_area_id)]}),
            (users["executor"], {"area_ids": [str(other_area_id)]}),
        ]:
            blocked = await client.patch(
                f"/api/v1/catalog/employees/{employee_id}/access", json=payload, headers=admin
            )
            assert blocked.status_code == 409
            assert blocked.json() == {"detail": "worker_has_active_order"}

        for employee_id in (users["master"], users["executor"]):
            added = await client.patch(
                f"/api/v1/catalog/employees/{employee_id}/access",
                json={"area_ids": [str(area_id), str(other_area_id)]},
                headers=admin,
            )
            assert added.status_code == 200
        master = bearer(await token(client, "master"))
        await cancel(client, master, order)
        for employee_id, payload in [
            (users["master"], {"role": "manager"}),
            (users["executor"], {"role": "manager"}),
            (users["master"], {"area_ids": []}),
            (users["executor"], {"area_ids": []}),
        ]:
            permitted = await client.patch(
                f"/api/v1/catalog/employees/{employee_id}/access", json=payload, headers=admin
            )
            assert permitted.status_code == 200


async def test_access_change_and_order_issue_serialize_on_master(database):
    users, area_id, _, _ = await people(database)
    async with database.sessions.begin() as session:
        equipment = Equipment(
            inventory_number="ACCESS-RACE",
            name="Access race pump",
            area_id=area_id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        equipment_id = equipment.id
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        master = bearer(await token(client, "master"))
        create, deactivate = await asyncio.gather(
            client.post(
                "/api/v1/work-orders",
                json=order_body(area_id, equipment_id, users["executor"]),
                headers=master | {"Idempotency-Key": str(uuid4())},
            ),
            client.patch(
                f"/api/v1/catalog/employees/{users['master']}/access",
                json={"is_active": False},
                headers=admin,
            ),
        )
        assert (create.status_code, deactivate.status_code) in {(201, 409), (401, 200), (409, 200)}


async def test_equipment_restore_and_order_issue_do_not_deadlock(database):
    users, area_id, _, _ = await people(database)
    async with database.sessions.begin() as session:
        equipment = Equipment(
            inventory_number="RESTORE-RACE",
            name="Restore race pump",
            area_id=area_id,
            equipment_type="pump",
            criticality=3,
            is_active=False,
        )
        session.add(equipment)
        await session.flush()
        equipment_id = equipment.id
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        master = bearer(await token(client, "master"))
        create, restore = await asyncio.gather(
            client.post(
                "/api/v1/work-orders",
                json=order_body(area_id, equipment_id, users["executor"]),
                headers=master | {"Idempotency-Key": str(uuid4())},
            ),
            client.patch(
                f"/api/v1/catalog/equipment/{equipment_id}",
                json={"is_active": True},
                headers=admin,
            ),
        )
        assert restore.status_code == 200
        assert create.status_code in {201, 409}
        assert create.status_code != 500 and restore.status_code != 500


async def test_reference_data_delete_guards_and_history_safe_edits(database):
    users, area_id, _, _ = await people(database)
    async with database.sessions.begin() as session:
        used_brigade = Brigade(code="USED-BR", name="Used brigade")
        free_brigade = Brigade(code="FREE-BR", name="Free brigade")
        used_fault = FaultCode(code="USED-FAULT", name="Used fault", specialty="mechanic")
        free_fault = FaultCode(code="FREE-FAULT", name="Free fault", specialty="mechanic")
        used_material = Material(code="USED-MAT", name="Used material", unit="l")
        free_material = Material(code="FREE-MAT", name="Free material", unit="kg")
        free_norm_fault = FaultCode(code="NORM-FAULT", name="Norm fault", specialty="mechanic")
        equipment = Equipment(
            inventory_number="REFERENCE-GUARDS",
            name="Reference guards pump",
            area_id=area_id,
            equipment_type="pump",
            criticality=3,
        )
        session.add_all(
            [
                used_brigade,
                free_brigade,
                used_fault,
                free_fault,
                used_material,
                free_material,
                free_norm_fault,
                equipment,
            ]
        )
        await session.flush()
        executor = await session.get(Employee, users["executor"])
        assert executor is not None
        executor.brigade_id = used_brigade.id
        session.add_all(
            [
                TimeNorm(fault_code_id=used_fault.id, equipment_type="pump", minutes=20),
                TimeNorm(fault_code_id=free_norm_fault.id, equipment_type="pump", minutes=25),
            ]
        )
        await session.flush()
        used_brigade_id = used_brigade.id
        free_brigade_id = free_brigade.id
        used_fault_id = used_fault.id
        free_fault_id = free_fault.id
        used_material_id = used_material.id
        free_material_id = free_material.id
        free_norm_id = await session.scalar(
            select(TimeNorm.id).where(TimeNorm.fault_code_id == free_norm_fault.id)
        )
        equipment_id = equipment.id

    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        master = bearer(await token(client, "master"))
        created = await issue(client, master, order_body(area_id, equipment_id, users["executor"]))
        async with database.sessions.begin() as session:
            session.add(
                MaterialUsage(
                    work_order_id=UUID(created["order_id"]),
                    material_id=used_material_id,
                    quantity="1.000",
                )
            )
            order = await session.get(WorkOrder, UUID(created["order_id"]))
            assert order is not None
            order.fault_code_id = used_fault_id

        for path in [
            f"/api/v1/catalog/brigades/{used_brigade_id}",
            f"/api/v1/catalog/fault-codes/{used_fault_id}",
            f"/api/v1/catalog/materials/{used_material_id}",
        ]:
            response = await client.delete(path, headers=admin)
            assert response.status_code == 409
            assert response.json() == {"detail": "reference_in_use"}

        material_change = await client.put(
            f"/api/v1/catalog/materials/{used_material_id}",
            json={"code": "USED-MAT", "name": "Renamed material", "unit": "l"},
            headers=admin,
        )
        assert material_change.status_code == 409
        assert material_change.json() == {"detail": "material_has_history"}
        assert (
            await client.put(
                f"/api/v1/catalog/materials/{used_material_id}",
                json={"code": "USED-MAT", "name": "Used material", "unit": "l"},
                headers=admin,
            )
        ).status_code == 200

        fault_change = await client.put(
            f"/api/v1/catalog/fault-codes/{used_fault_id}",
            json={"code": "USED-FAULT", "name": "Renamed fault", "specialty": "mechanic"},
            headers=admin,
        )
        assert fault_change.status_code == 409
        assert fault_change.json() == {"detail": "fault_code_has_history"}
        assert (
            await client.put(
                f"/api/v1/catalog/fault-codes/{used_fault_id}",
                json={"code": "USED-FAULT", "name": "Used fault", "specialty": "mechanic"},
                headers=admin,
            )
        ).status_code == 200

        equipment_type_change = await client.put(
            f"/api/v1/catalog/equipment/{equipment_id}",
            json={
                "inventory_number": "REFERENCE-GUARDS",
                "name": "Reference guards pump",
                "area_id": str(area_id),
                "equipment_type": "compressor",
                "criticality": 3,
            },
            headers=admin,
        )
        assert equipment_type_change.status_code == 409
        assert equipment_type_change.json() == {"detail": "equipment_type_has_history"}

        for path in [
            f"/api/v1/catalog/brigades/{free_brigade_id}",
            f"/api/v1/catalog/fault-codes/{free_fault_id}",
            f"/api/v1/catalog/materials/{free_material_id}",
            f"/api/v1/catalog/time-norms/{free_norm_id}",
        ]:
            assert (await client.delete(path, headers=admin)).status_code == 204

        assert (
            await client.delete(f"/api/v1/catalog/brigades/{used_brigade_id}", headers=master)
        ).status_code == 403
