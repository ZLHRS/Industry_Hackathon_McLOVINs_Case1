from __future__ import annotations

import io
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
from httpx2 import ASGITransport, AsyncClient
from PIL import Image
from sqlalchemy import func, select

from naryadai.app import create_app
from naryadai.auth.security import hash_secret
from naryadai.config import Settings
from naryadai.infrastructure.models import Area, Employee, EmployeeArea, Equipment, Photo, WorkOrder

pytestmark = pytest.mark.asyncio
_SECRET = "654321"


def _png() -> bytes:
    output = io.BytesIO()
    Image.new("RGBA", (48, 24), (20, 120, 40, 180)).save(output, format="PNG")
    return output.getvalue()


async def _order(database) -> UUID:
    async with database.sessions.begin() as session:
        area = Area(code="PHOTO", name="Photo area")
        session.add(area)
        await session.flush()
        master = Employee(
            login="photo-master",
            display_name="Photo master",
            role="master",
            specialty="mechanic",
            grade=5,
            password_hash=hash_secret(_SECRET),
        )
        executor = Employee(
            login="photo-executor",
            display_name="Photo executor",
            role="executor",
            specialty="mechanic",
            grade=3,
            password_hash=hash_secret(_SECRET),
        )
        session.add_all([master, executor])
        await session.flush()
        session.add_all(
            [
                EmployeeArea(employee_id=master.id, area_id=area.id),
                EmployeeArea(employee_id=executor.id, area_id=area.id),
            ]
        )
        equipment = Equipment(
            inventory_number="PHOTO-PUMP",
            name="Photo pump",
            area_id=area.id,
            equipment_type="pump",
            criticality=3,
        )
        session.add(equipment)
        await session.flush()
        order = WorkOrder(
            number="PHOTO-ORDER",
            work_type="unplanned",
            description="Capture initial condition",
            area_id=area.id,
            equipment_id=equipment.id,
            executor_id=executor.id,
            master_id=master.id,
            priority="high",
            status="issued",
            issued_at=datetime.now(UTC),
            deadline=datetime.now(UTC) + timedelta(hours=1),
        )
        session.add(order)
        await session.flush()
        return order.id


async def _token(client: AsyncClient, login: str) -> dict[str, str]:
    response = await client.post("/api/v1/auth/login", json={"login": login, "secret": _SECRET})
    assert response.status_code == 200, response.text
    return {"Authorization": "Bearer " + response.json()["access_token"]}


async def test_private_photo_upload_replay_and_download(database, tmp_path: Path) -> None:
    order_id = await _order(database)
    app = create_app(
        Settings(
            database_url=database.engine.url.render_as_string(hide_password=False),
            allowed_hosts=["testserver"],
            photo_root=tmp_path / "photos",
        )
    )
    path = f"/api/v1/work-orders/{order_id}/photos?kind=before&expected_version=1"
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        master = await _token(client, "photo-master")
        executor = await _token(client, "photo-executor")
        rejected = await client.post(
            path,
            content=b"not-an-image",
            headers=executor
            | {"Idempotency-Key": "photo-rejected-01", "Content-Type": "image/png"},
        )
        assert rejected.status_code == 403
        assert not list((tmp_path / "photos").glob("*.jpg"))

        headers = master | {"Idempotency-Key": "photo-before-001", "Content-Type": "image/png"}
        created = await client.post(path, content=_png(), headers=headers)
        assert created.status_code == 201, created.text
        result = created.json()
        assert result["version"] == 2
        assert result["kind"] == "before"
        assert len(result["sha256"]) == 64
        assert result["ai_share_allowed"] is False

        replay = await client.post(path, content=_png(), headers=headers)
        assert replay.status_code == 201, replay.text
        assert replay.json() == result

        downloaded = await client.get(result["content_url"], headers=master)
        assert downloaded.status_code == 200
        assert downloaded.headers["content-type"].startswith("image/jpeg")
        assert downloaded.headers["cache-control"] == "no-store"
        assert downloaded.headers["x-content-type-options"] == "nosniff"
        assert downloaded.content != _png()

    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(Photo)) == 1


async def _client_for(database, tmp_path: Path):
    app = create_app(
        Settings(
            database_url=database.engine.url.render_as_string(hide_password=False),
            allowed_hosts=["testserver"],
            photo_root=tmp_path / "photos",
            photo_max_bytes=1024,
        )
    )
    return app


async def test_photo_limits_streaming_stale_and_read_scope(database, tmp_path: Path) -> None:
    order_id = await _order(database)
    app = await _client_for(database, tmp_path)
    before_path = f"/api/v1/work-orders/{order_id}/photos?kind=before&expected_version=1"
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        master = await _token(client, "photo-master")
        executor = await _token(client, "photo-executor")

        async def oversized():
            yield b"x" * 600
            yield b"x" * 600

        streamed = await client.post(
            before_path,
            content=oversized(),
            headers=master
            | {"Idempotency-Key": "streamed-over-limit", "Content-Type": "image/png"},
        )
        assert streamed.status_code == 413

        old = "2020-01-01T00:00:00%2B00:00"
        created = await client.post(
            before_path + "&captured_at=" + old,
            content=_png(),
            headers=master | {"Idempotency-Key": "old-capture-time", "Content-Type": "image/png"},
        )
        assert created.status_code == 201, created.text
        result = created.json()
        future = (datetime.now(UTC) + timedelta(minutes=6)).isoformat().replace("+", "%2B")
        future_result = await client.post(
            f"/api/v1/work-orders/{order_id}/photos?kind=before&expected_version=2&captured_at={future}",
            content=_png(),
            headers=master
            | {"Idempotency-Key": "future-capture-time", "Content-Type": "image/png"},
        )
        assert future_result.status_code == 422

        stale = await client.post(
            before_path,
            content=_png(),
            headers=master
            | {"Idempotency-Key": "stale-photo-version", "Content-Type": "image/png"},
        )
        assert stale.status_code == 409
        assert len(list((tmp_path / "photos").glob("*.jpg"))) == 1

        async with database.sessions.begin() as session:
            order = await session.get(WorkOrder, order_id, with_for_update=True)
            assert order is not None
            order.status = "in_progress"
            order.started_at = datetime.now(UTC)

        version = result["version"]
        for index in range(5):
            after = await client.post(
                f"/api/v1/work-orders/{order_id}/photos?kind=after&expected_version={version}"
                + ("&ai_share_allowed=true" if index == 0 else ""),
                content=_png(),
                headers=executor
                | {
                    "Idempotency-Key": f"after-photo-{index:03d}",
                    "Content-Type": "image/png",
                },
            )
            assert after.status_code == 201, after.text
            assert after.json()["ai_share_allowed"] is (index == 0)
            version = after.json()["version"]
        sixth = await client.post(
            f"/api/v1/work-orders/{order_id}/photos?kind=after&expected_version={version}",
            content=_png(),
            headers=executor
            | {"Idempotency-Key": "after-photo-sixth", "Content-Type": "image/png"},
        )
        assert sixth.status_code == 409

        wrong_order = await client.get(
            f"/api/v1/work-orders/{UUID(int=1)}/photos/{result['photo_id']}", headers=master
        )
        assert wrong_order.status_code == 404

        async with database.sessions.begin() as session:
            order = await session.get(WorkOrder, order_id)
            assert order is not None
            outsider = Employee(
                login="photo-outsider",
                display_name="Photo outsider",
                role="executor",
                specialty="mechanic",
                grade=3,
                password_hash=hash_secret(_SECRET),
            )
            session.add(outsider)
            await session.flush()
            session.add(EmployeeArea(employee_id=outsider.id, area_id=order.area_id))
        outsider_headers = await _token(client, "photo-outsider")
        forbidden = await client.get(result["content_url"], headers=outsider_headers)
        assert forbidden.status_code == 404

    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(Photo)) == 6


async def test_photo_database_failure_removes_new_file(
    database, tmp_path: Path, monkeypatch
) -> None:
    order_id = await _order(database)
    app = await _client_for(database, tmp_path)

    async def fail_event(*_args, **_kwargs) -> None:
        raise RuntimeError("forced database-side failure")

    monkeypatch.setattr("naryadai.application.photos.record_event", fail_event)
    path = f"/api/v1/work-orders/{order_id}/photos?kind=before&expected_version=1"
    async with (
        app.router.lifespan_context(app),
        AsyncClient(
            transport=ASGITransport(app, raise_app_exceptions=False), base_url="http://testserver"
        ) as client,
    ):
        master = await _token(client, "photo-master")
        failed = await client.post(
            path,
            content=_png(),
            headers=master
            | {"Idempotency-Key": "forced-cleanup-case", "Content-Type": "image/png"},
        )
        assert failed.status_code == 500
    assert not list((tmp_path / "photos").glob("*.jpg"))
    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(Photo)) == 0
