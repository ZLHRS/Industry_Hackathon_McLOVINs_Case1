"""Replace only order-owned records, preserving catalogs, credentials and fault reports."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4, uuid5

from sqlalchemy import DateTime, Numeric, Uuid, delete, insert, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import Base

from .catalog import build_catalog
from .storage import LOCK_KEY, ROOT, SeedError, validate_target

ORDER_TABLES = frozenset(
    {
        "work_orders",
        "work_order_events",
        "work_order_participants",
        "material_usages",
        "photos",
        "ai_reviews",
        "ai_review_jobs",
        "idempotency_records",
        "outbox_events",
        "notifications",
        "push_deliveries",
    }
)
GENERATED_TABLES = frozenset({"work_orders", "work_order_events", "material_usages", "ai_reviews"})
FORMAT = "technaryad-orders-v1"
BACKUPS = ROOT / "var" / "order-backups"


def _tables() -> list[Any]:
    return [table for table in Base.metadata.sorted_tables if table.name in ORDER_TABLES]


def _condition(name: str) -> Any:
    table = Base.metadata.tables[name]
    if name == "notifications":
        return table.c.work_order_id.is_not(None)
    if name == "push_deliveries":
        notifications = Base.metadata.tables["notifications"]
        return table.c.notification_id.in_(
            select(notifications.c.id).where(notifications.c.work_order_id.is_not(None))
        )
    return text("true")  # These tables contain exclusively order-owned records.


async def _snapshot(session: AsyncSession) -> dict[str, list[dict[str, Any]]]:
    return {
        table.name: [
            dict(row)
            for row in (
                await session.execute(
                    select(table).where(_condition(table.name)).order_by(*table.primary_key.columns)
                )
            ).mappings()
        ]
        for table in _tables()
    }


async def _delete_orders(session: AsyncSession, schema: str) -> None:
    # Explicit maintenance only, after a verified backup and with every writer locked.
    # Transactional DDL restores the trigger even if any subsequent statement fails.
    await session.execute(
        text(
            f'ALTER TABLE "{schema}"."work_order_events" '
            "DISABLE TRIGGER work_order_events_immutable"
        )
    )
    for table in reversed(_tables()):
        await session.execute(delete(table).where(_condition(table.name)))
    await session.execute(
        text(
            f'ALTER TABLE "{schema}"."work_order_events" ENABLE TRIGGER work_order_events_immutable'
        )
    )


async def _insert(session: AsyncSession, dataset: dict[str, list[dict[str, Any]]]) -> None:
    for table in _tables():
        rows = dataset.get(table.name, [])
        if rows:
            await session.execute(insert(table), rows)


async def _lock(session: AsyncSession, schema: str) -> None:
    await session.execute(text("SET LOCAL lock_timeout = '10s'"))
    await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": LOCK_KEY})
    # Freeze catalogs too so validation, backup and replacement observe one state.
    tables = ", ".join(f'"{schema}"."{table.name}"' for table in Base.metadata.sorted_tables)
    await session.execute(text(f"LOCK TABLE {tables} IN EXCLUSIVE MODE"))


async def _check_linked_reports(session: AsyncSession) -> None:
    orders = Base.metadata.tables["work_orders"]
    linked = await session.scalar(
        select(orders.c.id).where(orders.c.fault_report_id.is_not(None)).limit(1)
    )
    if linked:
        raise SeedError(
            "Orders linked to fault reports exist. Replacement refused: deleting them would "
            "orphan converted reports. No data changed; resolve the report policy separately."
        )


async def _catalog(session: AsyncSession) -> dict[str, list[dict[str, Any]]]:
    template = build_catalog(lambda kind, key: uuid5(UUID(int=0), kind + key))
    keys = {
        "equipment": "inventory_number",
        "fault_codes": "code",
        "materials": "code",
        "employees": "login",
    }
    catalog: dict[str, list[dict[str, Any]]] = {}
    for name, key in keys.items():
        table = Base.metadata.tables[name]
        actual = {row[key]: dict(row) for row in (await session.execute(select(table))).mappings()}
        rows = []
        for expected in template[name]:
            if name == "employees" and expected["role"] not in {"master", "executor"}:
                continue
            row = actual.get(expected[key])
            if row is None:
                raise SeedError(
                    f"Required existing {name} entry is missing: {expected[key]}. "
                    "Catalogs will not be created or changed."
                )
            if row.get("is_active", True) is not True:
                raise SeedError(f"Required {name} entry is archived: {expected[key]}")
            fields = {
                "equipment": ("equipment_type",),
                "fault_codes": ("specialty",),
                "materials": ("unit",),
                "employees": ("role", "specialty"),
            }[name]
            if any(row[field] != expected[field] for field in fields):
                raise SeedError(
                    f"Required {name} entry has incompatible type/role/unit: {expected[key]}"
                )
            if name == "employees" and not row["is_on_shift"]:
                raise SeedError(
                    f"Required employee is off shift: {expected[key]}. "
                    "Shift flags will not be changed."
                )
            if name == "employees":
                row.pop("password_hash", None)
            rows.append(row)
        catalog[name] = rows
    return catalog


async def _validate_orders(session: AsyncSession, dataset: dict[str, list[dict[str, Any]]]) -> None:
    if set(dataset) != GENERATED_TABLES or not dataset["work_orders"]:
        raise SeedError("Only the four generated order tables may be inserted")
    area_table = Base.metadata.tables["areas"]
    active_areas = set(
        await session.scalars(select(area_table.c.id).where(area_table.c.is_active.is_(True)))
    )
    memberships = set((await session.execute(select(Base.metadata.tables["employee_areas"]))).all())
    for order in dataset["work_orders"]:
        if order.get("is_synthetic") is not True:
            raise SeedError("Generated orders must retain synthetic provenance")
        area = order["area_id"]
        if area not in active_areas or any(
            (order[key], area) not in memberships for key in ("master_id", "executor_id")
        ):
            raise SeedError(
                "Existing area permissions do not allow the generated assignments. "
                "No catalogs or permissions were changed."
            )


def _json_default(value: Any) -> str:
    if isinstance(value, (UUID, datetime, date, Decimal)):
        return str(value)
    raise TypeError(f"Unsupported backup value: {type(value).__name__}")


def _decode_rows(rows: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    if set(rows) != ORDER_TABLES:
        raise SeedError("Backup has an invalid table set")
    result = {}
    for table in _tables():
        decoded = []
        for row in rows[table.name]:
            if set(row) != set(table.c.keys()):
                raise SeedError("Backup columns do not match the current schema")
            item = dict(row)
            for column in table.c:
                value = item[column.name]
                if value is None:
                    continue
                if isinstance(column.type, Uuid):
                    item[column.name] = UUID(value)
                elif isinstance(column.type, DateTime):
                    item[column.name] = datetime.fromisoformat(value)
                elif isinstance(column.type, Numeric):
                    item[column.name] = Decimal(value)
            decoded.append(item)
        result[table.name] = decoded
    if any(row["work_order_id"] is None for row in result["notifications"]):
        raise SeedError("Backup may not contain fault report notifications")
    return result


def read_backup(
    path: Path, *, database: str, schema: str, revisions: list[str]
) -> dict[str, list[dict[str, Any]]]:
    try:
        raw = path.read_bytes()
        expected = path.with_suffix(".sha256").read_text().strip()
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError("checksum")
        payload = json.loads(raw)
        if (
            payload["format"] != FORMAT
            or payload["database"] != database
            or payload["schema"] != schema
            or payload["alembic_revisions"] != revisions
        ):
            raise ValueError("target")
        return _decode_rows(payload["rows"])
    except (OSError, ValueError, KeyError, TypeError):
        raise SeedError(
            "Order backup is unreadable, damaged or belongs to another target; no data changed"
        ) from None


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _backup(
    rows: dict[str, list[dict[str, Any]]], *, database: str, schema: str, revisions: list[str]
) -> Path:
    missing_parents = []
    parent = BACKUPS
    while not parent.exists():
        missing_parents.append(parent)
        parent = parent.parent
    for directory in reversed(missing_parents):
        directory.mkdir(mode=0o700, exist_ok=True)
        _fsync_directory(directory.parent)
    directory = BACKUPS / (datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    directory.mkdir(mode=0o700)
    path = directory / "orders.json"
    payload = {
        "format": FORMAT,
        "database": database,
        "schema": schema,
        "alembic_revisions": revisions,
        "created_at": datetime.now(UTC).isoformat(),
        "rows": rows,
    }
    raw = json.dumps(payload, default=_json_default, ensure_ascii=False).encode()
    for target, content in (
        (path, raw),
        (path.with_suffix(".sha256"), hashlib.sha256(raw).hexdigest().encode()),
    ):
        with target.open("xb") as stream:
            target.chmod(0o600)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    _fsync_directory(directory)
    _fsync_directory(BACKUPS)
    restored = read_backup(path, database=database, schema=schema, revisions=revisions)
    if restored != rows:
        raise SeedError("Order backup round-trip validation failed; no data changed")
    return path


async def refresh_orders(
    database: Database,
    *,
    environment: str,
    anchor: datetime,
    seed: int = 2026,
    preview: bool = False,
    restore: Path | None = None,
) -> dict[str, Any]:
    from .generator import generate_order_dataset

    schema = validate_target(database.engine.url.render_as_string(hide_password=False), environment)
    db_name = database.engine.url.database or ""
    if anchor > datetime.now(UTC):
        raise SeedError(
            "Anchor cannot be in the future: use today's actual issue time, deadlines may be later"
        )
    async with database.sessions.begin() as session:
        await _lock(session, schema)
        await _check_linked_reports(session)
        revisions = list(
            await session.scalars(
                text(f'SELECT version_num FROM "{schema}".alembic_version ORDER BY version_num')
            )
        )
        before = await _snapshot(session)
        if restore:
            replacement = read_backup(restore, database=db_name, schema=schema, revisions=revisions)
        else:
            catalog = await _catalog(session)
            replacement = generate_order_dataset(anchor=anchor, seed=seed, catalog=catalog)
            await _validate_orders(session, replacement)
        report: dict[str, Any] = {
            "changed": False,
            "anchor": anchor.isoformat(),
            "seed": seed,
            "delete_counts": {name: len(rows) for name, rows in before.items()},
            "insert_counts": {name: len(rows) for name, rows in replacement.items()},
            "preserved": sorted(set(Base.metadata.tables) - ORDER_TABLES),
            "preserved_also": [
                "fault report notifications and their push deliveries",
                "original photo files",
            ],
            "backup": None,
        }
        if preview:
            return report
        backup = await asyncio.to_thread(
            _backup, before, database=db_name, schema=schema, revisions=revisions
        )
        await _delete_orders(session, schema)
        await _insert(session, replacement)
        await session.flush()
        report.update(changed=True, backup=str(backup))
    return report
