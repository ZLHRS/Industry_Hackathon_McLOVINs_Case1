"""A real socket/Uvicorn workflow; no ASGI transport shortcuts or external services."""

import asyncio
import io
import os
import socket
import subprocess
import sys
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

import pytest
from httpx2 import AsyncClient
from PIL import Image
from sqlalchemy import select

from naryadai.demo.persist import seed_demo_database
from naryadai.infrastructure.models import Employee, Equipment, FaultCode, WorkOrder

pytestmark = pytest.mark.asyncio


async def test_real_http_workflow_with_private_evidence(database, tmp_path):
    await seed_demo_database(
        database,
        anchor_date=date(2026, 10, 5),
        seed=42,
        secret="local-http-test-only",
        environment="test",
    )
    async with database.sessions() as session:
        occupied = select(WorkOrder.executor_id).where(WorkOrder.status == "in_progress")
        executor = await session.scalar(
            select(Employee)
            .where(
                Employee.role == "executor",
                Employee.id.not_in(occupied),
            )
            .order_by(Employee.login)
        )
        equipment = await session.scalar(select(Equipment).order_by(Equipment.inventory_number))
        fault = await session.scalar(select(FaultCode).order_by(FaultCode.code))
    assert executor is not None and equipment is not None and fault is not None
    image = io.BytesIO()
    Image.new("RGB", (960, 640), "steelblue").save(image, format="PNG")
    photo = image.getvalue()
    env = {
        **os.environ,
        "NARYADAI_ENVIRONMENT": "test",
        "NARYADAI_DATABASE_URL": database.engine.url.render_as_string(hide_password=False),
        "NARYADAI_PHOTO_ROOT": str(tmp_path / "live-photos"),
    }
    # Inherit an already bound socket so parallel test runs cannot steal the selected port.
    with socket.socket() as sock, (tmp_path / "uvicorn.log").open("w") as log:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "naryadai.app:create_app",
                "--factory",
                "--fd",
                str(sock.fileno()),
                "--no-access-log",
                "--no-proxy-headers",
            ],
            pass_fds=(sock.fileno(),),
            env=env,
            cwd=tmp_path,
            stdout=log,
            stderr=log,
        )
        try:
            async with AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=10) as client:
                for _ in range(60):
                    try:
                        if (await client.get("/api/v1/health/ready")).status_code == 200:
                            break
                    except OSError:
                        pass
                    except Exception:
                        if process.poll() is not None:
                            raise AssertionError("Uvicorn exited; see local test log") from None
                    await asyncio.sleep(0.05)
                else:
                    raise AssertionError("Uvicorn did not become ready")

                async def login(name):
                    response = await client.post(
                        "/api/v1/auth/login",
                        json={
                            "login": name,
                            "secret": "local-http-test-only",
                        },
                    )
                    assert response.status_code == 200
                    return {"Authorization": "Bearer " + response.json()["access_token"]}

                master = await login("demo.master1")
                worker = await login(executor.login)
                created = await client.post(
                    "/api/v1/work-orders",
                    json={
                        "description": "HTTP test fixture: inspect synthetic pump",
                        "work_type": "unplanned",
                        "area_id": str(equipment.area_id),
                        "equipment_id": str(equipment.id),
                        "executor_id": str(executor.id),
                        "priority": "emergency",
                        "deadline": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
                    },
                    headers=master | {"Idempotency-Key": str(uuid4())},
                )
                assert created.status_code == 201, created.text
                order = created.json()
                path = "/api/v1/work-orders/" + order["order_id"]

                async def upload(kind, headers):
                    response = await client.post(
                        path + "/photos",
                        params={"kind": kind, "expected_version": order["version"]},
                        content=photo,
                        headers=headers
                        | {"Content-Type": "image/png", "Idempotency-Key": str(uuid4())},
                    )
                    assert response.status_code == 201, response.text
                    return response.json()

                before = await upload("before", master)
                order.update(before)
                for action in ["accept", "start"]:
                    response = await client.post(
                        path + "/actions",
                        json={
                            "action": action,
                            "expected_version": order["version"],
                        },
                        headers=worker | {"Idempotency-Key": str(uuid4())},
                    )
                    assert response.status_code == 200, response.text
                    order.update(response.json())
                after = await upload("after", worker)
                order.update(after)
                content = await client.get(after["content_url"], headers=worker)
                assert content.status_code == 200
                assert content.headers["content-type"] == "image/jpeg"
                assert content.headers["cache-control"] == "no-store"
                assert Image.open(io.BytesIO(content.content)).format == "JPEG"
                assert (await client.get(after["content_url"])).status_code == 401
                assert (
                    await client.get("/var/photos/" + after["photo_id"] + ".jpg")
                ).status_code == 404

                response = await client.post(
                    path + "/actions",
                    json={
                        "action": "complete",
                        "expected_version": order["version"],
                        "completion": {
                            "work_description": "Inspected fixture and verified secure photo flow",
                            "fault_code_id": str(fault.id),
                            "materials": [],
                            "no_materials_reason": "Inspection only; no replacement parts",
                        },
                    },
                    headers=worker | {"Idempotency-Key": str(uuid4())},
                )
                assert response.status_code == 200, response.text
                assert response.json()["status"] == "completed"
                detail = (await client.get(path, headers=master)).json()
                assert len(detail["photos"]) == 2
                assert "storage_key" not in str(detail)
                events = (await client.get(path + "/events", headers=master)).json()["items"]
                assert [event["action"] for event in events] == [
                    "issue",
                    "photo_uploaded",
                    "accept",
                    "start",
                    "photo_uploaded",
                    "complete",
                ]
                assert len({event["order_version"] for event in events}) == 6
        finally:
            process.terminate()
            await asyncio.to_thread(process.wait, timeout=10)
