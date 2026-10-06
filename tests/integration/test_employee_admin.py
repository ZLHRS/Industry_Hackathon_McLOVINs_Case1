from uuid import uuid4

import pytest
from httpx2 import ASGITransport, AsyncClient
from test_auth import app_for, bearer, people, token

pytestmark = pytest.mark.asyncio


async def test_admin_employee_detail_create_and_access_include_area_ids(database):
    users, first_id, other_id, _ = await people(database)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        master = bearer(await token(client, "master"))
        executor_id = str(users["executor"])

        detail = await client.get(f"/api/v1/catalog/employees/{executor_id}", headers=admin)
        assert detail.status_code == 200
        assert detail.json()["area_ids"] == [str(first_id)]
        assert "password_hash" not in detail.text and "secret" not in detail.text
        assert (
            await client.get(f"/api/v1/catalog/employees/{executor_id}", headers=master)
        ).status_code == 403

        listing = await client.get("/api/v1/catalog/employees", headers=admin)
        assert listing.status_code == 200
        listed_executor = next(row for row in listing.json() if row["id"] == executor_id)
        assert "area_ids" not in listed_executor

        created = await client.post(
            "/api/v1/catalog/employees",
            headers=admin,
            json={
                "login": "workshop.user",
                "display_name": "Workshop user",
                "role": "executor",
                "specialty": "mechanic",
                "area_ids": [str(other_id), str(first_id)],
                "secret": "created-secret",
            },
        )
        assert created.status_code == 201, created.text
        created_id = created.json()["id"]
        assert set(created.json()["area_ids"]) == {str(first_id), str(other_id)}
        assert "secret" not in created.text and "password_hash" not in created.text

        changed = await client.patch(
            f"/api/v1/catalog/employees/{created_id}/access",
            headers=admin,
            json={"area_ids": [str(other_id)]},
        )
        assert changed.status_code == 200
        assert changed.json()["area_ids"] == [str(other_id)]

        invalid = await client.patch(
            f"/api/v1/catalog/employees/{created_id}/access",
            headers=admin,
            json={"area_ids": [str(uuid4())]},
        )
        assert invalid.status_code == 409
        unchanged = await client.get(f"/api/v1/catalog/employees/{created_id}", headers=admin)
        assert unchanged.json()["area_ids"] == [str(other_id)]


async def test_admin_cannot_disable_or_demote_self_but_can_rotate_password(database):
    users, _, _, _ = await people(database)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        path = f"/api/v1/catalog/employees/{users['admin']}/access"
        for payload in ({"is_active": False}, {"role": "manager"}):
            response = await client.patch(path, headers=admin, json=payload)
            assert response.status_code == 409
            assert response.json() == {"detail": "self_access_change_forbidden"}
        assert (await client.get("/api/v1/auth/me", headers=admin)).status_code == 200

        changed = await client.patch(path, headers=admin, json={"secret": "rotated-secret"})
        assert changed.status_code == 200
        assert changed.json()["role"] == "admin"
        assert "secret" not in changed.text and "password_hash" not in changed.text
        assert (await client.get("/api/v1/auth/me", headers=admin)).status_code == 401
        assert await token(client, "admin", "rotated-secret")


async def test_non_admin_cannot_mutate_employee_access(database):
    users, _, _, _ = await people(database)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        executor = bearer(await token(client, "executor"))
        path = f"/api/v1/catalog/employees/{users['master']}/access"
        denied = await client.patch(path, headers=executor, json={"role": "admin"})
        assert denied.status_code == 403
        assert (await client.get(path.removesuffix("/access"), headers=executor)).status_code == 403
