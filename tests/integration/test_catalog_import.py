"""Real HTTP checks for the bounded add-only catalog XLSX import."""

import asyncio
from io import BytesIO

import pytest
import xlsxwriter
from httpx2 import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from test_auth import app_for, bearer, people, token

from naryadai.application.catalog_import import MIME
from naryadai.infrastructure.models import Area, Equipment, Material

pytestmark = pytest.mark.asyncio


def _workbook(
    area_code: str,
    *,
    material_name: str = "Seal",
    material_unit: str = "pcs",
    inventory_number: str = "IMPORT-001",
) -> bytes:
    stream = BytesIO()
    book = xlsxwriter.Workbook(stream, {"in_memory": True})
    equipment = book.add_worksheet("Equipment")
    materials = book.add_worksheet("Materials")
    equipment.write_row(
        0,
        0,
        ["area_code", "inventory_number", "name", "equipment_type", "criticality"],
    )
    equipment.write_row(1, 0, [area_code, inventory_number, "Import pump", "pump", 3])
    materials.write_row(0, 0, ["code", "name", "unit"])
    materials.write_row(1, 0, ["IMPORT-MAT", material_name, material_unit])
    book.close()
    return stream.getvalue()


async def test_catalog_import_preview_apply_and_exact_replay(database):
    _users, area_id, _other_area, _ = await people(database)
    async with database.sessions() as session:
        area = await session.get(Area, area_id)
        assert area is not None
        content = _workbook(area.code)
        before_equipment = await session.scalar(select(func.count()).select_from(Equipment))
        before_materials = await session.scalar(select(func.count()).select_from(Material))
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        master = bearer(await token(client, "master"))
        headers = admin | {"Content-Type": MIME}
        template = await client.get("/api/v1/catalog/import-template.xlsx", headers=master)
        denied = await client.post(
            "/api/v1/catalog/import/preview", content=content, headers=master
        )
        assert template.status_code == 403 and denied.status_code == 403
        async with database.sessions() as session:
            after_equipment = await session.scalar(select(func.count()).select_from(Equipment))
            after_materials = await session.scalar(select(func.count()).select_from(Material))
            assert after_equipment == before_equipment and after_materials == before_materials
        preview = await client.post(
            "/api/v1/catalog/import/preview", content=content, headers=headers
        )
        assert preview.status_code == 200, preview.text
        body = preview.json()
        assert body["equipment"]["create"] == 1 and body["materials"]["create"] == 1
        applied = await client.post(
            "/api/v1/catalog/import/apply",
            content=content,
            headers=headers | {"X-Import-Fingerprint": body["fingerprint"]},
        )
        assert applied.status_code == 200, applied.text
        assert applied.json()["created_equipment"] == 1
        assert applied.json()["created_materials"] == 1
        replay = await client.post(
            "/api/v1/catalog/import/apply",
            content=content,
            headers=headers | {"X-Import-Fingerprint": body["fingerprint"]},
        )
        assert replay.status_code == 200
        assert replay.json()["created_equipment"] == 0
        assert replay.json()["equipment"]["skip"] == 1


async def test_catalog_import_invalid_mixed_file_is_atomic_and_archived_area_is_rejected(database):
    _users, area_id, _other_area, _ = await people(database)
    async with database.sessions() as session:
        area = await session.get(Area, area_id)
        assert area is not None
        invalid = _workbook(area.code, material_unit="")
        archived = _workbook(area.code, inventory_number="IMPORT-ARCHIVED")
        before_equipment = await session.scalar(select(func.count()).select_from(Equipment))
        before_materials = await session.scalar(select(func.count()).select_from(Material))
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        headers = admin | {"Content-Type": MIME}
        preview = await client.post(
            "/api/v1/catalog/import/preview", content=invalid, headers=headers
        )
        assert preview.status_code == 200
        assert preview.json()["equipment"]["create"] == 1
        assert preview.json()["materials"]["error"] == 1
        invalid_apply = await client.post(
            "/api/v1/catalog/import/apply",
            content=invalid,
            headers=headers | {"X-Import-Fingerprint": preview.json()["fingerprint"]},
        )
        assert invalid_apply.status_code == 422
        async with database.sessions() as session:
            assert (
                await session.scalar(select(func.count()).select_from(Equipment))
                == before_equipment
            )
            assert (
                await session.scalar(select(func.count()).select_from(Material)) == before_materials
            )
        async with database.sessions.begin() as session:
            area = await session.get(Area, area_id)
            assert area is not None
            area.is_active = False
        inactive_preview = await client.post(
            "/api/v1/catalog/import/preview", content=archived, headers=headers
        )
        assert inactive_preview.status_code == 200
        assert inactive_preview.json()["equipment"]["error"] == 1
        assert (
            inactive_preview.json()["equipment"]["rows"][0]["errors"][0]["code"] == "unknown_area"
        )


async def test_catalog_import_stale_snapshot_and_non_admin_roles(database):
    _users, area_id, _other_area, _ = await people(database)
    async with database.sessions() as session:
        area = await session.get(Area, area_id)
        assert area is not None
        content = _workbook(area.code)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        admin = bearer(await token(client, "admin"))
        headers = admin | {"Content-Type": MIME}
        preview = await client.post(
            "/api/v1/catalog/import/preview", content=content, headers=headers
        )
        assert preview.status_code == 200
        async with database.sessions.begin() as session:
            session.add(Material(code="IMPORT-MAT", name="Changed elsewhere", unit="pcs"))
        stale = await client.post(
            "/api/v1/catalog/import/apply",
            content=content,
            headers=headers | {"X-Import-Fingerprint": preview.json()["fingerprint"]},
        )
        assert stale.status_code == 409
        assert stale.json()["detail"] == "catalog_import_stale"
        async with database.sessions() as session:
            assert (
                await session.scalar(
                    select(Equipment).where(Equipment.inventory_number == "IMPORT-001")
                )
                is None
            )
            existing = await session.scalar(select(Material).where(Material.code == "IMPORT-MAT"))
            assert existing is not None and existing.name == "Changed elsewhere"
        for role in ("master", "executor", "manager"):
            denied = bearer(await token(client, role)) | {"Content-Type": MIME}
            assert (
                await client.get("/api/v1/catalog/import-template.xlsx", headers=denied)
            ).status_code == 403
            assert (
                await client.post("/api/v1/catalog/import/preview", content=content, headers=denied)
            ).status_code == 403
            assert (
                await client.post(
                    "/api/v1/catalog/import/apply",
                    content=content,
                    headers=denied | {"X-Import-Fingerprint": "f" * 64},
                )
            ).status_code == 403


async def test_catalog_import_preflight_accepts_fingerprint_header(database):
    await people(database)
    app = app_for(database, cors_origins=("http://ui.example",))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        response = await client.options(
            "/api/v1/catalog/import/apply",
            headers={
                "Origin": "http://ui.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-import-fingerprint",
            },
        )
    assert response.status_code == 200
    assert "x-import-fingerprint" in response.headers["access-control-allow-headers"].casefold()


async def test_catalog_import_waits_for_existing_crud_row_lock_without_deadlock(database):
    _users, area_id, _other_area, _ = await people(database)
    async with database.sessions() as session:
        area = await session.get(Area, area_id)
        content = _workbook(area.code)
    app = app_for(database)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        headers = bearer(await token(client, "admin")) | {"Content-Type": MIME}
        preview = await client.post(
            "/api/v1/catalog/import/preview", content=content, headers=headers
        )
        async with database.sessions() as editing:
            # Match ordinary area editing: acquire a row lock before changing data.
            area = await editing.get(Area, area_id, with_for_update=True)
            pending = asyncio.create_task(
                client.post(
                    "/api/v1/catalog/import/apply",
                    content=content,
                    headers=headers | {"X-Import-Fingerprint": preview.json()["fingerprint"]},
                )
            )
            try:
                async with asyncio.timeout(5):
                    while True:
                        async with database.sessions() as observer:
                            waiting = await observer.scalar(
                                text(
                                    "SELECT EXISTS (SELECT 1 FROM pg_locks "
                                    "WHERE relation = 'areas'::regclass AND NOT granted "
                                    "AND mode = 'ExclusiveLock')"
                                )
                            )
                        if waiting:
                            break
                        await asyncio.sleep(0.02)
                    area.code = "CHANGED"
                    await editing.commit()
                    response = await pending
                assert response.status_code == 409
            finally:
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
        async with database.sessions() as session:
            assert (
                await session.scalar(
                    select(Equipment).where(Equipment.inventory_number == "IMPORT-001")
                )
                is None
            )
