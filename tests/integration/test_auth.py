from datetime import UTC, datetime, timedelta

import pytest
from httpx2 import ASGITransport, AsyncClient
from sqlalchemy import select, update

from naryadai.app import create_app
from naryadai.auth.security import hash_secret
from naryadai.config import Settings
from naryadai.infrastructure.models import (
    Area,
    AuthSession,
    Employee,
    EmployeeArea,
    Equipment,
    LoginThrottle,
)

pytestmark = pytest.mark.asyncio
SECRET = "654321"


async def people(database):
    async with database.sessions.begin() as session:
        first = Area(code="A1", name="First")
        other = Area(code="A2", name="Other")
        session.add_all([first, other])
        await session.flush()
        hashed = hash_secret(SECRET)
        users = {}
        for role in ["admin", "master", "executor", "manager"]:
            user = Employee(
                login=role,
                display_name=role,
                role=role,
                specialty="mechanic",
                grade=3,
                password_hash=hashed,
            )
            session.add(user)
            await session.flush()
            session.add(EmployeeArea(employee_id=user.id, area_id=first.id))
            users[role] = user.id
        machine = Equipment(
            inventory_number="OTHER",
            name="Hidden",
            area_id=other.id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(machine)
        await session.flush()
        return users, first.id, other.id, machine.id


def app_for(database, **kwargs):
    url = database.engine.url.render_as_string(hide_password=False)
    return create_app(Settings(database_url=url, allowed_hosts=["testserver"], **kwargs))


async def token(client, login="executor", secret=SECRET):
    response = await client.post("/api/v1/auth/login", json={"login": login, "secret": secret})
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def bearer(value):
    return {"Authorization": "Bearer " + value}


async def test_login_me_logout_and_hash_only_storage(database):
    await people(database)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        value = await token(client)
        me = await client.get("/api/v1/auth/me", headers=bearer(value))
        assert me.status_code == 200
        assert me.json()["role"] == "executor"
        assert "password" not in me.text and "token" not in me.text
        async with database.sessions() as session:
            stored = (await session.scalars(select(AuthSession))).one()
            assert stored.token_hash != value
            assert len(stored.token_hash) == 64
        assert (await client.post("/api/v1/auth/logout", headers=bearer(value))).status_code == 204
        assert (await client.get("/api/v1/auth/me", headers=bearer(value))).status_code == 401


async def test_invalid_expired_and_disabled_sessions(database):
    users, *_ = await people(database)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        for headers in [{}, bearer("x" * 43), {"Authorization": "Basic abc"}]:
            assert (await client.get("/api/v1/auth/me", headers=headers)).status_code == 401
        expired = await token(client)
        async with database.sessions.begin() as session:
            await session.execute(
                update(AuthSession).values(
                    created_at=datetime.now(UTC) - timedelta(days=2),
                    expires_at=datetime.now(UTC) - timedelta(days=1),
                )
            )
        assert (await client.get("/api/v1/auth/me", headers=bearer(expired))).status_code == 401
        active = await token(client)
        async with database.sessions.begin() as session:
            await session.execute(
                update(Employee).where(Employee.id == users["executor"]).values(is_active=False)
            )
        assert (await client.get("/api/v1/auth/me", headers=bearer(active))).status_code == 401
        assert (
            await client.post("/api/v1/auth/login", json={"login": "executor", "secret": SECRET})
        ).status_code == 401


async def test_failed_login_limits_are_persistent_and_shared(database):
    await people(database)
    app = app_for(database, login_account_limit=2)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        for _ in range(2):
            response = await client.post(
                "/api/v1/auth/login", json={"login": "executor", "secret": "wrong-value"}
            )
            assert response.status_code == 401
    # A new app instance must not reset the lockout.
    other = app_for(database, login_account_limit=2)
    async with (
        other.router.lifespan_context(other),
        AsyncClient(transport=ASGITransport(other), base_url="http://testserver") as client,
    ):
        response = await client.post(
            "/api/v1/auth/login", json={"login": "executor", "secret": SECRET}
        )
        assert response.status_code == 429
        assert response.headers["Retry-After"] == "900"
        async with database.sessions.begin() as session:
            await session.execute(
                update(LoginThrottle).values(
                    window_started_at=datetime.now(UTC) - timedelta(hours=1)
                )
            )
        assert await token(client)


async def test_unknown_login_and_wrong_secret_share_response(database):
    await people(database)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        responses = []
        for login in ["executor", "unknown-person"]:
            response = await client.post(
                "/api/v1/auth/login", json={"login": login, "secret": "wrong-value"}
            )
            responses.append((response.status_code, response.json()))
        assert responses[0] == responses[1] == (401, {"detail": "invalid_credentials"})


async def test_peer_limit_cannot_be_bypassed_by_forwarded_header(database):
    await people(database)
    app = app_for(database, login_peer_limit=1)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        assert await token(client)
        response = await client.post(
            "/api/v1/auth/login",
            json={"login": "master", "secret": SECRET},
            headers={"X-Forwarded-For": "different-peer"},
        )
        assert response.status_code == 429


async def test_scopes_and_admin_only_catalog_writes(database):
    _, first_id, _other_id, machine_id = await people(database)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        executor = bearer(await token(client))
        master = bearer(await token(client, "master"))
        admin = bearer(await token(client, "admin"))
        assert (await client.get("/api/v1/catalog")).status_code == 401
        response = await client.get("/api/v1/catalog", headers=executor)
        assert response.status_code == 200
        assert [r["id"] for r in response.json()["areas"]] == [str(first_id)]
        assert response.json()["equipment"] == []
        assert (
            await client.get(f"/api/v1/catalog/equipment/{machine_id}", headers=executor)
        ).status_code == 404
        assert (
            await client.get(f"/api/v1/catalog/equipment/{machine_id}", headers=admin)
        ).status_code == 200
        assert (await client.get("/api/v1/catalog/employees", headers=executor)).status_code == 403
        assert (await client.get("/api/v1/catalog/employees", headers=master)).status_code == 200
        body = {"code": "NEW", "name": "New area"}
        for headers in [executor, master]:
            assert (
                await client.post("/api/v1/catalog/areas", json=body, headers=headers)
            ).status_code == 403
        response = await client.post("/api/v1/catalog/areas", json=body, headers=admin)
        assert response.status_code == 201
        assert (
            await client.post("/api/v1/catalog/areas", json=body, headers=admin)
        ).status_code == 409
        response = await client.put(
            "/api/v1/catalog/areas/" + response.json()["id"],
            json={"code": "UPDATED", "name": "Updated"},
            headers=admin,
        )
        assert response.status_code == 200


async def test_admin_access_changes_revoke_sessions(database):
    users, _, other_id, _ = await people(database)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        executor = bearer(await token(client))
        admin = bearer(await token(client, "admin"))
        path = f"/api/v1/catalog/employees/{users['executor']}/access"
        assert (
            await client.patch(path, json={"role": "admin"}, headers=executor)
        ).status_code == 403
        response = await client.patch(
            path, json={"area_ids": [str(other_id)], "secret": "new-secret"}, headers=admin
        )
        assert response.status_code == 200
        assert "password_hash" not in response.text
        assert (await client.get("/api/v1/auth/me", headers=executor)).status_code == 401
        value = await token(client, secret="new-secret")
        response = await client.get("/api/v1/auth/me", headers=bearer(value))
        assert response.json()["area_ids"] == [str(other_id)]


async def test_admin_can_create_account_and_bad_reference_rolls_back(database):
    _, first_id, *_ = await people(database)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        body = {
            "login": "new-user",
            "display_name": "New synthetic",
            "role": "executor",
            "specialty": "mechanic",
            "area_ids": [str(first_id)],
            "secret": "123456",
        }
        created = await client.post("/api/v1/catalog/employees", json=body, headers=admin)
        assert created.status_code == 201
        assert "secret" not in created.text
        assert await token(client, "new-user", "123456")
        body["login"] = "bad-user"
        body["area_ids"] = ["00000000-0000-0000-0000-000000000001"]
        assert (
            await client.post("/api/v1/catalog/employees", json=body, headers=admin)
        ).status_code == 409
        async with database.sessions() as session:
            assert (
                await session.scalar(select(Employee).where(Employee.login == "bad-user")) is None
            )


@pytest.mark.parametrize(
    "kind", ["brigades", "equipment", "fault-codes", "materials", "time-norms"]
)
async def test_admin_reference_create_update_and_conflicts(database, kind):
    from uuid import uuid4

    _, first_id, *_ = await people(database)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        fault = await client.post(
            "/api/v1/catalog/fault-codes",
            json={"code": "F1", "name": "Fault", "specialty": "mechanic"},
            headers=admin,
        )
        bodies = {
            "brigades": {"code": "B1", "name": "Brigade"},
            "equipment": {
                "inventory_number": "E1",
                "name": "Equipment",
                "area_id": str(first_id),
                "equipment_type": "pump",
                "criticality": 3,
            },
            "fault-codes": {"code": "F2", "name": "Fault", "specialty": "electrician"},
            "materials": {"code": "M1", "name": "Material", "unit": "piece"},
            "time-norms": {
                "fault_code_id": fault.json()["id"],
                "equipment_type": "pump",
                "minutes": 60,
            },
        }
        url = "/api/v1/catalog/" + kind
        body = bodies[kind]
        created = await client.post(url, json=body, headers=admin)
        assert created.status_code == 201, created.text
        assert (await client.post(url, json=body, headers=admin)).status_code == 409
        changed = dict(body)
        if kind == "time-norms":
            changed["minutes"] = 90
        else:
            changed["name"] = "Updated"
        assert (
            await client.put(url + "/" + created.json()["id"], json=changed, headers=admin)
        ).status_code == 200
        assert (
            await client.put(url + "/" + str(uuid4()), json=changed, headers=admin)
        ).status_code == 404
        # A second record cannot acquire the first record's unique key.
        other = dict(body)
        key = (
            "equipment_type"
            if kind == "time-norms"
            else ("inventory_number" if kind == "equipment" else "code")
        )
        other[key] = "different"
        second = await client.post(url, json=other, headers=admin)
        assert second.status_code == 201, second.text
        assert (
            await client.put(url + "/" + second.json()["id"], json=body, headers=admin)
        ).status_code == 409
        assert (await client.get("/api/v1/catalog", headers=admin)).status_code == 200


async def test_concurrent_login_limit_cannot_be_overspent(database):
    import asyncio

    await people(database)
    app = app_for(database, login_account_limit=1)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):

        async def attempt():
            return await client.post(
                "/api/v1/auth/login", json={"login": "executor", "secret": SECRET}
            )

        responses = await asyncio.gather(attempt(), attempt())
        assert sorted(r.status_code for r in responses) == [200, 429]
        async with database.sessions() as session:
            assert len((await session.scalars(select(AuthSession))).all()) == 1


async def test_readiness_requires_current_migration(database):
    from sqlalchemy import text

    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        assert (await client.get("/api/v1/health/ready")).status_code == 200
        async with database.sessions.begin() as session:
            await session.execute(text("UPDATE alembic_version SET version_num='old_revision'"))
        assert (await client.get("/api/v1/health/ready")).status_code == 503
        assert (await client.get("/api/v1/health/live")).status_code == 200
        async with database.sessions.begin() as session:
            await session.execute(text("DROP TABLE alembic_version"))
        assert (await client.get("/api/v1/health/ready")).status_code == 503


async def test_invalid_secret_not_echoed_in_validation_error(database):
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        secret = "SENSITIVE" * 30
        response = await client.post(
            "/api/v1/auth/login", json={"login": "executor", "secret": secret}
        )
        assert response.status_code == 422
        assert secret not in response.text
        assert "input" not in response.json()["detail"][0]
