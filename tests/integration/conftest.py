"""Real PostgreSQL tests: one migrated, isolated schema per test; never SQLite."""

import asyncio
import os
import re
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy.engine import make_url

from naryadai.infrastructure.database import Database

ROOT = Path(__file__).resolve().parents[2]
# Capture before the autouse unit-test fixture removes application environment variables.
CONFIGURED_URL = os.environ.get("NARYADAI_TEST_DATABASE_URL")


@pytest_asyncio.fixture
async def database(request):
    local_file = ROOT / "var/postgres/test-url"
    url = CONFIGURED_URL
    if not url and local_file.is_file():
        url = local_file.read_text().strip()
    if not url:
        if request.config.getoption("--require-db"):
            pytest.fail("Set NARYADAI_TEST_DATABASE_URL to a dedicated PostgreSQL *_test database")
        pytest.skip("PostgreSQL unavailable; use --require-db to make missing evidence fail")
    assert make_url(url).database.endswith("_test"), "Refusing a non-test database"
    admin = Database(url)
    schema = "test_" + uuid4().hex
    assert re.fullmatch(r"test_[0-9a-f]{32}", schema)
    async with admin.engine.begin() as connection:
        await connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    test_url = (
        make_url(url)
        .update_query_dict({"options": "-csearch_path=" + schema})
        .render_as_string(hide_password=False)
    )
    instance = Database(test_url)
    try:
        env = {**os.environ, "NARYADAI_DATABASE_URL": test_url}
        result = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, "-m", "alembic", "-c", str(ROOT / "alembic.ini"), "upgrade", "head"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        yield instance
    finally:
        await instance.dispose()
        async with admin.engine.begin() as connection:
            await connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        await admin.dispose()
