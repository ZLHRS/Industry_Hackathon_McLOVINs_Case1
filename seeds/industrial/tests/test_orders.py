# ruff: noqa: RUF001
"""Only isolated *_test schemas: never the domain's database."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from seeds.industrial import orders
from seeds.industrial.generator import generate_dataset
from seeds.industrial.storage import SeedError, maintain
from sqlalchemy import delete, insert, select, text, update
from sqlalchemy.exc import DBAPIError, IntegrityError

from naryadai.infrastructure.models import Base

ANCHOR = datetime(2026, 10, 14, 19, tzinfo=UTC)  # Oct 15 midnight in Kostanay


async def prepare(database, monkeypatch, tmp_path):
    monkeypatch.setattr(orders, "BACKUPS", tmp_path / "order-backups")
    data = generate_dataset(anchor=ANCHOR - timedelta(days=7))
    await maintain(
        database,
        action="apply",
        environment="test",
        dataset=data,
        anchor=ANCHOR.date(),
        secret="isolated-only-test-secret",
    )
    employees = Base.metadata.tables["employees"]
    areas = Base.metadata.tables["areas"]
    sessions = Base.metadata.tables["auth_sessions"]
    session_id, subscription_id = uuid4(), uuid4()
    async with database.sessions.begin() as session:
        await session.execute(
            insert(areas), {"id": uuid4(), "code": "USER-AREA", "name": "Не менять"}
        )
        employee = data["employees"][0]["id"]
        await session.execute(
            update(employees)
            .where(employees.c.id == employee)
            .values(display_name="Свое имя мастера")
        )
        await session.execute(
            insert(sessions),
            {
                "id": session_id,
                "employee_id": employee,
                "token_hash": "a" * 64,
                "created_at": ANCHOR,
                "expires_at": ANCHOR + timedelta(days=1),
            },
        )
        await session.execute(
            insert(Base.metadata.tables["push_subscriptions"]),
            {
                "id": subscription_id,
                "employee_id": employee,
                "session_id": session_id,
                "endpoint": "https://push.invalid/test",
                "endpoint_hash": "c" * 64,
                "p256dh": "test-key",
                "auth": "test-auth",
            },
        )
        order_id = data["work_orders"][0]["id"]
        await session.execute(
            insert(Base.metadata.tables["photos"]),
            {
                "id": uuid4(),
                "work_order_id": order_id,
                "kind": "after",
                "storage_key": "retained.jpg",
                "author_id": employee,
                "sha256": "d" * 64,
                "size_bytes": 123,
            },
        )
        await session.execute(
            insert(Base.metadata.tables["ai_review_jobs"]),
            {
                "id": uuid4(),
                "work_order_id": order_id,
                "submission_version": 1,
            },
        )
        await session.execute(
            insert(Base.metadata.tables["idempotency_records"]),
            {
                "actor_id": employee,
                "key": "old-order-action",
                "order_id": order_id,
                "request_hash": "e" * 64,
                "response": {"id": str(order_id)},
            },
        )
        await session.execute(
            insert(Base.metadata.tables["outbox_events"]),
            {
                "id": uuid4(),
                "work_order_id": order_id,
                "event_id": data["work_order_events"][0]["id"],
                "event_type": "issue",
                "payload": {},
            },
        )
        report_id = uuid4()
        await session.execute(
            insert(Base.metadata.tables["fault_reports"]),
            {
                "id": report_id,
                "equipment_id": data["equipment"][0]["id"],
                "area_id": data["equipment"][0]["area_id"],
                "reporter_id": data["employees"][2]["id"],
                "master_id": employee,
                "description": "Сохранить сообщение о поломке",
                "idempotency_key": "preserve-me",
                "request_hash": "b" * 64,
            },
        )
        for is_report in (False, True):
            notification_id = uuid4()
            await session.execute(
                insert(Base.metadata.tables["notifications"]),
                {
                    "id": notification_id,
                    "employee_id": employee,
                    "work_order_id": None if is_report else data["work_orders"][0]["id"],
                    "fault_report_id": report_id if is_report else None,
                    "dedup_key": str(uuid4()),
                    "kind": "issue",
                    "title": "Сохранить" if is_report else "Заменить",
                    "body": "Тест",
                },
            )
            await session.execute(
                insert(Base.metadata.tables["push_deliveries"]),
                {
                    "id": uuid4(),
                    "notification_id": notification_id,
                    "subscription_id": subscription_id,
                },
            )
    return data


async def assert_history_protected(database):
    async with database.sessions() as session:
        enabled = await session.scalar(
            text(
                "SELECT tgenabled FROM pg_trigger "
                "WHERE tgrelid = 'work_order_events'::regclass "
                "AND tgname = 'work_order_events_immutable'"
            )
        )
        assert enabled == "O"
    with pytest.raises(DBAPIError, match="append-only"):
        async with database.sessions.begin() as session:
            table = Base.metadata.tables["work_order_events"]
            await session.execute(
                delete(table).where(table.c.id == select(table.c.id).limit(1).scalar_subquery())
            )


async def snapshot_all(database):
    async with database.sessions() as session:
        return {
            table.name: [
                dict(row)
                for row in (
                    await session.execute(select(table).order_by(*table.primary_key.columns))
                ).mappings()
            ]
            for table in Base.metadata.sorted_tables
        }


@pytest.mark.asyncio
async def test_order_only_refresh_preview_and_verified_restore(database, monkeypatch, tmp_path):
    await prepare(database, monkeypatch, tmp_path)
    before = await snapshot_all(database)
    await assert_history_protected(database)
    preview = await orders.refresh_orders(database, environment="test", anchor=ANCHOR, preview=True)
    assert not preview["changed"] and preview["insert_counts"]["work_orders"] == 600
    assert await snapshot_all(database) == before
    assert not (tmp_path / "order-backups").exists()
    result = await orders.refresh_orders(database, environment="test", anchor=ANCHOR)
    after = await snapshot_all(database)
    await assert_history_protected(database)
    assert result["changed"] and result["backup"]
    for name in set(before) - orders.ORDER_TABLES:
        assert after[name] == before[name], name
    assert after["notifications"] == [
        row for row in before["notifications"] if row["fault_report_id"]
    ]
    assert not (
        {row["id"] for row in before["work_orders"]} & {row["id"] for row in after["work_orders"]}
    )
    notification_ids = {row["id"] for row in after["notifications"]}
    assert after["push_deliveries"] == [
        row for row in before["push_deliveries"] if row["notification_id"] in notification_ids
    ]
    from pathlib import Path

    backup = Path(result["backup"])
    assert backup.stat().st_mode & 0o777 == 0o600
    await orders.refresh_orders(database, environment="test", anchor=ANCHOR, restore=backup)
    assert await snapshot_all(database) == before


@pytest.mark.asyncio
async def test_backup_or_insert_failure_leaves_every_table_untouched(
    database, monkeypatch, tmp_path
):
    await prepare(database, monkeypatch, tmp_path)
    before = await snapshot_all(database)
    original = orders._backup

    def fail(*args, **kwargs):
        raise SeedError("Backup failed")

    monkeypatch.setattr(orders, "_backup", fail)
    with pytest.raises(SeedError, match="Backup failed"):
        await orders.refresh_orders(database, environment="test", anchor=ANCHOR)
    assert await snapshot_all(database) == before
    monkeypatch.setattr(orders, "_backup", original)
    from seeds.industrial import generator

    real_generate = generator.generate_order_dataset

    def invalid(**kwargs):
        data = real_generate(**kwargs)
        data["work_orders"][0]["equipment_id"] = uuid4()
        return data

    monkeypatch.setattr(generator, "generate_order_dataset", invalid)
    with pytest.raises(IntegrityError):
        await orders.refresh_orders(database, environment="test", anchor=ANCHOR)
    assert await snapshot_all(database) == before
    await assert_history_protected(database)


@pytest.mark.asyncio
async def test_refuses_to_orphan_fault_reports_or_change_catalogs(database, monkeypatch, tmp_path):
    await prepare(database, monkeypatch, tmp_path)
    async with database.sessions.begin() as session:
        report = await session.scalar(select(Base.metadata.tables["fault_reports"].c.id))
        table = Base.metadata.tables["work_orders"]
        order = await session.scalar(select(table.c.id).limit(1))
        await session.execute(
            update(table).where(table.c.id == order).values(fault_report_id=report)
        )
    before = await snapshot_all(database)
    with pytest.raises(SeedError, match="linked to fault reports"):
        await orders.refresh_orders(database, environment="test", anchor=ANCHOR)
    assert await snapshot_all(database) == before


@pytest.mark.asyncio
async def test_cli_order_refresh_does_not_rewrite_credentials(
    database, monkeypatch, tmp_path, capsys
):
    await prepare(database, monkeypatch, tmp_path)
    from argparse import Namespace

    from seeds.industrial import __main__ as cli

    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setenv(
        "NARYADAI_DATABASE_URL", database.engine.url.render_as_string(hide_password=False)
    )
    monkeypatch.setenv("NARYADAI_ENVIRONMENT", "test")
    credentials = tmp_path / "var/industrial-credentials.txt"
    credentials.parent.mkdir()
    credentials.write_text("existing private credentials unchanged")
    args = Namespace(action="replace-orders", confirm=None, anchor=ANCHOR, seed=2026, backup=None)
    with pytest.raises(SeedError, match="requires --confirm"):
        await cli.run(args)
    args.confirm = "REPLACE-ORDERS"
    await cli.run(args)
    assert credentials.read_text() == "existing private credentials unchanged"
    assert "credentials" not in capsys.readouterr().out
