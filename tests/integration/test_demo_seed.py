from datetime import date

import pytest
from sqlalchemy import func, select

from naryadai.demo.persist import SeedRefusalError, seed_demo_database
from naryadai.infrastructure.models import Employee, Photo, WorkOrder, WorkOrderEvent

ANCHOR = date(2026, 10, 5)
_TEST_SECRET = "test-only-demo-secret"


@pytest.mark.asyncio
async def test_seed_is_idempotent_and_persists_required_fixture(database) -> None:
    created = await seed_demo_database(
        database,
        anchor_date=ANCHOR,
        seed=42,
        secret=_TEST_SECRET,
        environment="test",
    )
    assert created.already_seeded is False
    assert created.counts["work_orders"] == 600
    assert created.counts["photos"] == 0

    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(WorkOrder)) == 600
        assert await session.scalar(select(func.count()).select_from(WorkOrderEvent)) > 600
        assert await session.scalar(select(func.count()).select_from(Photo)) == 0
        password_hash = await session.scalar(
            select(Employee.password_hash).where(Employee.login == "demo.executor01")
        )
    assert password_hash is not None

    repeated = await seed_demo_database(
        database,
        anchor_date=ANCHOR,
        seed=42,
        secret="another-test-secret",
        environment="test",
    )
    assert repeated.already_seeded is True
    assert repeated.counts == created.counts
    async with database.sessions() as session:
        assert (
            await session.scalar(
                select(Employee.password_hash).where(Employee.login == "demo.executor01")
            )
            == password_hash
        )


@pytest.mark.asyncio
async def test_seed_refuses_mismatch_and_production(database) -> None:
    with pytest.raises(SeedRefusalError, match="6 to 128"):
        await seed_demo_database(
            database,
            anchor_date=ANCHOR,
            seed=42,
            secret="short",
            environment="test",
        )

    with pytest.raises(SeedRefusalError, match="production"):
        await seed_demo_database(
            database,
            anchor_date=ANCHOR,
            seed=42,
            secret=_TEST_SECRET,
            environment="production",
        )

    await seed_demo_database(
        database,
        anchor_date=ANCHOR,
        seed=42,
        secret=_TEST_SECRET,
        environment="test",
    )
    with pytest.raises(SeedRefusalError, match="empty database"):
        await seed_demo_database(
            database,
            anchor_date=ANCHOR,
            seed=43,
            secret=_TEST_SECRET,
            environment="test",
        )
