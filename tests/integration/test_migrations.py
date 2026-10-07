"""Check schema drift and reversibility only inside the disposable test schema."""

import asyncio
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.asyncio
ROOT = Path(__file__).resolve().parents[2]


async def alembic(database, *args):
    env = {
        **os.environ,
        "NARYADAI_DATABASE_URL": database.engine.url.render_as_string(hide_password=False),
    }
    result = await asyncio.to_thread(
        subprocess.run,
        [sys.executable, "-m", "alembic", "-c", str(ROOT / "alembic.ini"), *args],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout + result.stderr


async def test_migration_matches_orm_metadata(database):
    result = await alembic(database, "check")
    assert "No new upgrade operations detected" in result


async def test_initial_migration_roundtrip_on_empty_schema(database):
    await alembic(database, "downgrade", "base")
    async with database.sessions() as session:
        assert (
            await session.execute(
                text(
                    "SELECT count(*) FROM information_schema.tables "
                    "WHERE table_schema=current_schema() AND table_name <> 'alembic_version'"
                )
            )
        ).scalar_one() == 0
    await alembic(database, "upgrade", "head")
    async with database.sessions() as session:
        assert (
            await session.execute(text("SELECT version_num FROM alembic_version"))
        ).scalar_one() == "0006_photo_ai_consent"


async def test_photo_consent_migration_makes_existing_photos_private(database):
    """The consent default protects historical photos during an in-place upgrade."""

    await alembic(database, "downgrade", "0005_catalog_archiving")
    area_id, equipment_id = uuid4(), uuid4()
    master_id, executor_id, order_id, photo_id = uuid4(), uuid4(), uuid4(), uuid4()
    async with database.sessions.begin() as session:
        await session.execute(
            text("INSERT INTO areas (id, code, name, is_active) VALUES (:id, 'A', 'Area', true)"),
            {"id": area_id},
        )
        for employee_id, login, role in (
            (master_id, "master", "master"),
            (executor_id, "executor", "executor"),
        ):
            await session.execute(
                text(
                    "INSERT INTO employees "
                    "(id, login, display_name, role, specialty, grade, password_hash) "
                    "VALUES (:id, :login, :login, :role, 'mechanic', 4, 'x')"
                ),
                {"id": employee_id, "login": login, "role": role},
            )
        await session.execute(
            text(
                "INSERT INTO equipment "
                "(id, inventory_number, name, area_id, equipment_type, criticality, is_active) "
                "VALUES (:id, 'EQ-1', 'Equipment', :area_id, 'pump', 3, true)"
            ),
            {"id": equipment_id, "area_id": area_id},
        )
        await session.execute(
            text(
                "INSERT INTO work_orders "
                "(id, number, work_type, description, area_id, equipment_id, executor_id, "
                "master_id, "
                "priority, status, deadline, attempt) "
                "VALUES (:id, 'NR-MIGRATION', 'unplanned', 'Repair', :area_id, :equipment_id, "
                ":executor_id, :master_id, 'normal', 'issued', now() + interval '1 hour', 1)"
            ),
            {
                "id": order_id,
                "area_id": area_id,
                "equipment_id": equipment_id,
                "executor_id": executor_id,
                "master_id": master_id,
            },
        )
        await session.execute(
            text(
                "INSERT INTO photos "
                "(id, work_order_id, kind, attempt, storage_key, author_id, sha256, size_bytes) "
                "VALUES (:id, :work_order_id, 'after', 1, 'legacy-photo.jpg', :author_id, "
                ":sha256, 1)"
            ),
            {
                "id": photo_id,
                "work_order_id": order_id,
                "author_id": executor_id,
                "sha256": "a" * 64,
            },
        )

    await alembic(database, "upgrade", "head")
    async with database.sessions() as session:
        assert (
            await session.execute(
                text("SELECT ai_share_allowed FROM photos WHERE id = :id"), {"id": photo_id}
            )
        ).scalar_one() is False
