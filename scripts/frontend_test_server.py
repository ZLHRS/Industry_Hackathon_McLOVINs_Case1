"""Serve a seeded isolated PostgreSQL schema for local frontend E2E."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import uvicorn
from sqlalchemy import select
from sqlalchemy.engine import make_url

from naryadai.application.push_delivery import deliver_push
from naryadai.config import Settings
from naryadai.demo.persist import seed_demo_database
from naryadai.domain.lifecycle import WorkOrderStatus
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    Area,
    Employee,
    EmployeeArea,
    Equipment,
    FaultCode,
    Material,
    WorkOrder,
)
from naryadai.worker import run_worker

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 58_001
_SCHEMA = re.compile(r"e2e_[0-9a-f]{32}$")


class E2EServerError(RuntimeError):
    """Raised before unsafe E2E setup can modify any database."""


def _read_test_database_url() -> str:
    if value := os.environ.get("NARYADAI_TEST_DATABASE_URL"):
        return value
    path = ROOT / "var" / "postgres" / "test-url"
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    raise E2EServerError("Set NARYADAI_TEST_DATABASE_URL to a dedicated PostgreSQL *_test database")


def _require_test_database_url(value: str) -> str:
    try:
        parsed = make_url(value)
    except Exception as error:
        raise E2EServerError("NARYADAI_TEST_DATABASE_URL is not a valid database URL") from error
    if (
        parsed.drivername != "postgresql+psycopg"
        or not parsed.database
        or not parsed.database.endswith("_test")
    ):
        raise E2EServerError("Refusing a database whose name does not end in _test")
    return value


def _schema_url(database_url: str, schema: str) -> str:
    if not _SCHEMA.fullmatch(schema):
        raise E2EServerError("Refusing an unexpected E2E schema name")
    parsed = make_url(database_url)
    existing = str(parsed.query.get("options", "")).strip()
    options = (existing + " -csearch_path=" + schema).strip()
    return parsed.update_query_dict({"options": options}).render_as_string(hide_password=False)


def _metadata_path(value: str | None) -> Path:
    path = (ROOT / (value or "tmp/e2e-server.json")).resolve()
    safe_root = (ROOT / "tmp").resolve()
    if safe_root not in path.parents:
        raise E2EServerError("E2E metadata must be stored under the ignored tmp directory")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _run_migrations(database_url: str) -> None:
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ROOT / "alembic.ini"), "upgrade", "head"],
        cwd=ROOT,
        env=os.environ | {"NARYADAI_DATABASE_URL": database_url},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise E2EServerError("Alembic migration failed for the isolated E2E schema")


async def _write_metadata(
    database: Database, *, path: Path, port: int, secret: str
) -> dict[str, Any]:
    async with database.sessions() as session:
        occupied = select(WorkOrder.executor_id).where(
            WorkOrder.status == WorkOrderStatus.IN_PROGRESS
        )
        executor_row = await session.execute(
            select(Employee, EmployeeArea.area_id)
            .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
            .where(
                Employee.role == "executor",
                Employee.is_active.is_(True),
                Employee.is_on_shift.is_(True),
                Employee.id.not_in(occupied),
            )
            .order_by(Employee.login)
            .limit(1)
        )
        executor, area_id = executor_row.one()
        master = await session.scalar(
            select(Employee)
            .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
            .where(
                Employee.role == "master",
                Employee.is_active.is_(True),
                EmployeeArea.area_id == area_id,
            )
            .order_by(Employee.login)
            .limit(1)
        )
        manager = await session.scalar(
            select(Employee).where(Employee.role == "manager", Employee.is_active.is_(True))
        )
        admin = await session.scalar(
            select(Employee).where(Employee.role == "admin", Employee.is_active.is_(True))
        )
        area = await session.get(Area, area_id)
        equipment = await session.scalar(
            select(Equipment)
            .where(Equipment.area_id == area_id)
            .order_by(Equipment.inventory_number)
            .limit(1)
        )
        fault = await session.scalar(select(FaultCode).order_by(FaultCode.code).limit(1))
        material = await session.scalar(select(Material).order_by(Material.code).limit(1))
    if any(item is None for item in (master, manager, admin, area, equipment, fault, material)):
        raise E2EServerError("Demo seed lacks required E2E identities or catalog data")

    payload = {
        "base_url": "http://127.0.0.1:" + str(port),
        "secret": secret,
        "master_login": master.login,
        "executor_login": executor.login,
        "manager_login": manager.login,
        "admin_login": admin.login,
        "selected_executor_id": str(executor.id),
        "area_id": str(area.id),
        "equipment_id": str(equipment.id),
        "fault_code_id": str(fault.id),
        "material_id": str(material.id),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    path.chmod(0o600)
    return payload


async def _drop_schema(database_url: str, schema: str) -> None:
    if not _SCHEMA.fullmatch(schema):
        raise E2EServerError("Refusing to drop an unexpected schema name")
    database = Database(database_url)
    try:
        async with database.engine.begin() as connection:
            await connection.exec_driver_sql('DROP SCHEMA "' + schema + '" CASCADE')
    finally:
        await database.dispose()


def _configure_application(database_url: str, photo_root: Path) -> None:
    os.environ.update(
        {
            "NARYADAI_ENVIRONMENT": "test",
            "NARYADAI_DATABASE_URL": database_url,
            "NARYADAI_ALLOWED_HOSTS": '["localhost", "127.0.0.1"]',
            "NARYADAI_LOGIN_ACCOUNT_LIMIT": "20",
            "NARYADAI_LOGIN_PEER_LIMIT": "200",
            "NARYADAI_PHOTO_ROOT": str(photo_root),
        }
    )


async def run_server(*, port: int, metadata_path: Path, secret: str) -> None:
    if not 1 <= port <= 65_535:
        raise E2EServerError("port must be between 1 and 65535")
    database_url = _require_test_database_url(_read_test_database_url())
    schema = "e2e_" + uuid4().hex
    isolated_url = _schema_url(database_url, schema)
    admin = Database(database_url)
    database: Database | None = None
    schema_created = False
    worker_task: asyncio.Task[None] | None = None
    photo_root = ROOT / "tmp" / ("e2e-photos-" + schema)
    try:
        async with admin.engine.begin() as connection:
            await connection.exec_driver_sql('CREATE SCHEMA "' + schema + '"')
        schema_created = True
        await asyncio.to_thread(_run_migrations, isolated_url)
        database = Database(isolated_url)
        await seed_demo_database(
            database,
            anchor_date=datetime.now(UTC).date(),
            seed=42,
            secret=secret,
            environment="test",
        )
        _configure_application(isolated_url, photo_root)
        worker_settings = Settings(
            web_push_private_key_file=None,
            web_push_subject=None,
            ai_api_key=None,
            ai_vision_enabled=False,
        )
        worker_task = asyncio.create_task(
            run_worker(database, worker_settings, deliver=deliver_push)
        )
        server = uvicorn.Server(
            uvicorn.Config(
                "naryadai.app:create_app",
                factory=True,
                host="127.0.0.1",
                port=port,
                access_log=False,
                log_level="warning",
                ws="websockets-sansio",
                ws_max_size=4096,
            )
        )
        serve_task = asyncio.create_task(server.serve())
        while not server.started:
            if serve_task.done():
                await serve_task
                raise E2EServerError("Uvicorn exited before becoming ready")
            await asyncio.sleep(0.05)
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(signum, setattr, server, "should_exit", True)
        await _write_metadata(database, path=metadata_path, port=port, secret=secret)
        print(
            "E2E backend ready at http://127.0.0.1:"
            + str(port)
            + "; metadata: "
            + str(metadata_path)
        )
        await serve_task
    finally:
        if worker_task is not None:
            worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await worker_task
        if database is not None:
            await database.dispose()
        metadata_path.unlink(missing_ok=True)
        if photo_root.exists():
            shutil.rmtree(photo_root)
        if schema_created:
            await _drop_schema(database_url, schema)
        await admin.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--state-file", default="tmp/e2e-server.json")
    args = parser.parse_args()
    secret = os.environ.get("NARYADAI_E2E_SECRET") or secrets.token_urlsafe(32)
    try:
        asyncio.run(
            run_server(port=args.port, metadata_path=_metadata_path(args.state_file), secret=secret)
        )
    except E2EServerError as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
