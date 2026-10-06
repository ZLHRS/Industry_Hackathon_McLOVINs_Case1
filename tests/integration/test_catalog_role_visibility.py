"""Reference data follows each role's actual workspace needs."""

import pytest
from httpx2 import ASGITransport, AsyncClient

from naryadai.app import create_app
from naryadai.auth.security import hash_secret
from naryadai.config import Settings
from naryadai.infrastructure.models import (
    Area,
    Brigade,
    Employee,
    EmployeeArea,
    Equipment,
    FaultCode,
    Material,
    TimeNorm,
)


@pytest.mark.asyncio
async def test_catalog_role_visibility_and_area_scope(database):
    secret = "catalog-test-password"
    async with database.sessions.begin() as session:
        area = Area(code="HOME", name="Assigned area")
        foreign = Area(code="OTHER", name="Other area")
        fault = FaultCode(code="INSPECT", name="Inspection", specialty="mechanic")
        session.add_all([area, foreign, fault])
        await session.flush()
        session.add_all(
            [
                Brigade(code="TEAM", name="Repair team"),
                Material(code="OIL", name="Oil", unit="l"),
                TimeNorm(fault_code_id=fault.id, equipment_type="pump", minutes=30),
            ]
        )
        for target, code in [(area, "HOME-01"), (foreign, "OTHER-01")]:
            session.add(
                Equipment(
                    inventory_number=code,
                    name=code,
                    area_id=target.id,
                    equipment_type="pump",
                    criticality=3,
                )
            )
        hashed = hash_secret(secret)
        for role in ["executor", "master", "manager", "admin"]:
            employee = Employee(
                login=role,
                display_name=role,
                role=role,
                specialty="mechanic",
                grade=3,
                password_hash=hashed,
            )
            session.add(employee)
            await session.flush()
            session.add(EmployeeArea(employee_id=employee.id, area_id=area.id))
    app = create_app(
        Settings(
            database_url=database.engine.url.render_as_string(hide_password=False),
            allowed_hosts=["testserver"],
        )
    )
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        for role in ["executor", "master", "manager", "admin"]:
            login = await client.post("/api/v1/auth/login", json={"login": role, "secret": secret})
            assert login.status_code == 200
            headers = {"Authorization": "Bearer " + login.json()["access_token"]}
            response = await client.get("/api/v1/catalog", headers=headers)
            assert response.status_code == 200
            data = response.json()
            assert {row["code"] for row in data["areas"]} == (
                {"HOME", "OTHER"} if role == "admin" else {"HOME"}
            )
            assert {row["inventory_number"] for row in data["equipment"]} == (
                {"HOME-01", "OTHER-01"} if role == "admin" else {"HOME-01"}
            )
            assert len(data["fault_codes"]) == 1
            assert len(data["brigades"]) == (1 if role in {"master", "admin"} else 0)
            assert len(data["time_norms"]) == (1 if role in {"master", "admin"} else 0)
            assert len(data["materials"]) == (0 if role == "manager" else 1)
