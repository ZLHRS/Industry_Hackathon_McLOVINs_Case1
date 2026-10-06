import os
import subprocess
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from seeds.industrial import storage
from seeds.industrial.storage import SeedError, maintain, status, validate_target
from sqlalchemy import insert, select
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from naryadai.infrastructure.models import Area, Employee, SeedRun, WorkOrder

ANCHOR = datetime(2026, 10, 6, 12, tzinfo=UTC)
SECRET = "only-for-isolated-tests"


def dataset():
    from seeds.industrial.generator import generate_dataset

    return generate_dataset(anchor=ANCHOR, seed=2026)


async def apply(database, action="apply", rows=None):
    return await maintain(
        database,
        action=action,
        environment="test",
        dataset=rows or dataset(),
        anchor=ANCHOR.date(),
        seed=2026,
        secret=SECRET,
    )


@pytest.mark.parametrize(
    "url,environment",
    [
        ("postgresql+psycopg://x:private@db.example.com/db", "development"),
        ("postgresql+psycopg://x:private@127.0.0.1/db", "production"),
        ("postgresql+psycopg://x:private@localhost/db?host=remote", "test"),
        ("postgresql+psycopg://x:private@localhost/db?options=-csearch_path=public,other", "test"),
        ("postgresql+psycopg://x:private@localhost/db?sslmode=disable", "test"),
    ],
)
def test_refuses_unsafe_targets_without_echoing_credentials(url, environment):
    with pytest.raises(SeedError) as error:
        validate_target(url, environment)
    assert "private" not in str(error.value)


@pytest.mark.asyncio
async def test_apply_is_idempotent_and_clear_makes_verified_backup(database):
    result = await apply(database)
    assert result.changed
    assert result.counts["work_orders"] >= 500
    async with database.sessions() as session:
        password = await session.scalar(select(Employee.password_hash))
    again = await apply(database)
    assert not again.changed
    assert again.counts == result.counts
    async with database.sessions() as session:
        assert await session.scalar(select(Employee.password_hash)) == password
    cleared = await maintain(database, action="clear", environment="test")
    assert cleared.changed and not any(cleared.counts.values())
    assert cleared.backup is not None and cleared.backup.stat().st_size > 1000
    assert cleared.backup.stat().st_mode & 0o777 == 0o600
    assert (cleared.backup.parent / "metadata.json").exists()
    assert not (await maintain(database, action="clear", environment="test")).changed
    parsed = make_url(database.engine.url)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    environment.update(
        {
            "PGHOST": parsed.host,
            "PGPORT": str(parsed.port or 5432),
            "PGDATABASE": parsed.database,
            "PGUSER": parsed.username,
            "PGPASSWORD": parsed.password,
        }
    )
    restored = subprocess.run(
        [
            "pg_restore",
            "--clean",
            "--if-exists",
            "--single-transaction",
            "--dbname",
            parsed.database,
            str(cleared.backup),
        ],
        env=environment,
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert restored.returncode == 0, "Backup restore failed"
    assert (await status(database, environment="test"))["counts"] == result.counts


@pytest.mark.asyncio
async def test_replace_rolls_back_if_new_dataset_has_invalid_references(database):
    await apply(database)
    before = await status(database, environment="test")
    broken = dataset()
    broken["work_orders"][0]["equipment_id"] = uuid4()
    with pytest.raises(IntegrityError):
        await apply(database, action="replace", rows=broken)
    assert await status(database, environment="test") == before


@pytest.mark.asyncio
async def test_failed_backup_preserves_original_data(database, monkeypatch):
    await apply(database)
    before = await status(database, environment="test")

    def refuse(*_):
        raise SeedError("Backup failed")

    monkeypatch.setattr(storage, "_backup", refuse)
    with pytest.raises(SeedError, match="Backup failed"):
        await apply(database, action="replace")
    assert await status(database, environment="test") == before


@pytest.mark.asyncio
async def test_clear_refuses_foreign_seed_and_apply_refuses_occupied_database(database):
    async with database.sessions.begin() as session:
        session.add(Area(id=uuid4(), code="EXISTING", name="Existing"))
        session.add(SeedRun(id="other-seed", seed=1, anchor_date=ANCHOR.date(), created_at=ANCHOR))
    with pytest.raises(SeedError, match="empty database"):
        await apply(database)
    with pytest.raises(SeedError, match="owned"):
        await maintain(database, action="clear", environment="test")
    result = await apply(database, action="replace")
    assert result.changed and result.backup and result.backup.exists()


@pytest.mark.asyncio
async def test_clear_preserves_new_non_seed_work(database):
    await apply(database)
    row = dataset()["work_orders"][0] | {
        "id": uuid4(),
        "number": "USER-NEW-ORDER",
        "is_synthetic": False,
    }
    async with database.sessions.begin() as session:
        await session.execute(insert(WorkOrder), [row])
    before = await status(database, environment="test")
    with pytest.raises(SeedError, match="non-seed orders"):
        await maintain(database, action="clear", environment="test")
    assert await status(database, environment="test") == before


@pytest.mark.asyncio
async def test_clear_preserves_user_added_catalog_records(database):
    await apply(database)
    async with database.sessions.begin() as session:
        session.add(Area(id=uuid4(), code="USER-AREA", name="User-created area"))
    before = await status(database, environment="test")
    with pytest.raises(SeedError, match="New non-seed records exist in areas"):
        await maintain(database, action="clear", environment="test")
    assert await status(database, environment="test") == before
