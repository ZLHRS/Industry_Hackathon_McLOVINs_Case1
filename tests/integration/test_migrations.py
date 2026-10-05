"""Check schema drift and reversibility only inside the disposable test schema."""

import asyncio
import os
import subprocess
import sys
from pathlib import Path

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
        ).scalar_one() == "0003_notifications"
