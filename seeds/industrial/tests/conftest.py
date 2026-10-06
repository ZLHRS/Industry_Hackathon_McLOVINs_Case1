"""Seed tests use only a fresh schema in the dedicated *_test database."""

import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy.engine import make_url

from naryadai.infrastructure.database import Database

ROOT = Path(__file__).resolve().parents[3]


@pytest_asyncio.fixture
async def database(monkeypatch, tmp_path):
    url = os.environ.get("NARYADAI_TEST_DATABASE_URL")
    if not url:
        source = ROOT / "var/postgres/test-url"
        if not source.is_file():
            pytest.fail("A dedicated PostgreSQL *_test database is required")
        url = source.read_text().strip()
    assert make_url(url).database.endswith("_test"), "Refusing a non-test database"
    admin = Database(url)
    schema = "test_" + uuid4().hex
    async with admin.engine.begin() as connection:
        await connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    isolated = make_url(url).update_query_dict({"options": "-csearch_path=" + schema})
    instance = Database(isolated.render_as_string(hide_password=False))
    try:
        env = {
            **os.environ,
            "NARYADAI_DATABASE_URL": isolated.render_as_string(hide_password=False),
        }
        process = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            check=False,
        )
        assert process.returncode == 0, "Test schema migrations failed"
        from seeds.industrial import storage

        monkeypatch.setattr(storage, "BACKUPS", tmp_path / "backups")
        yield instance
    finally:
        await instance.dispose()
        async with admin.engine.begin() as connection:
            await connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        await admin.dispose()
