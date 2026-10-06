"""Local-only, transactional seed maintenance with mandatory replacement backups."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import func, insert, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from naryadai.auth.security import hash_secret
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import Base, SeedRun, WorkOrder

ROOT = Path(__file__).resolve().parents[2]
BACKUPS = ROOT / "var" / "seed-backups"
PREFIX = "industrial-v1:"
LOCK_KEY = 5437891113  # Shared with the legacy seed: concurrent initializers serialize.


class SeedError(RuntimeError):
    """Safe refusal that can be printed without credentials or connection details."""


@dataclass(frozen=True)
class Result:
    changed: bool
    counts: dict[str, int]
    backup: Path | None = None


def identity(anchor: date, seed: int) -> str:
    digest = hashlib.sha256(f"{anchor}:{seed}".encode()).hexdigest()[:48]
    return PREFIX + digest


def validate_target(url: str, environment: str) -> str:
    parsed = make_url(url)
    if environment not in {"development", "test"}:
        raise SeedError("Only development/test databases may be seeded")
    if parsed.drivername != "postgresql+psycopg" or parsed.host not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise SeedError("Only an explicit loopback PostgreSQL target is allowed")
    if not parsed.database or set(parsed.query) - {"options"}:
        raise SeedError("Unsupported database or connection options")
    options = parsed.query.get("options", "-csearch_path=public")
    if not isinstance(options, str) or not re.fullmatch(
        r"-csearch_path=(public|test_[a-f0-9]{32})", options
    ):
        raise SeedError("Use public or one isolated test schema")
    return options.split("=", 1)[1]


async def counts(session: AsyncSession) -> dict[str, int]:
    return {
        table.name: int(await session.scalar(select(func.count()).select_from(table)) or 0)
        for table in Base.metadata.sorted_tables
    }


async def status(database: Database, *, environment: str) -> dict[str, Any]:
    schema = validate_target(database.engine.url.render_as_string(hide_password=False), environment)
    async with database.sessions() as session:
        return {
            "database": database.engine.url.database,
            "schema": schema,
            "counts": await counts(session),
            "seed_runs": list(await session.scalars(select(SeedRun.id))),
        }


def _backup(url: str, schema: str, before: dict[str, int]) -> Path:
    executable = shutil.which("pg_dump")
    inspector = shutil.which("pg_restore")
    if not executable or not inspector:
        raise SeedError("pg_dump and pg_restore are required before changing existing data")
    BACKUPS.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = BACKUPS / (datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    directory.mkdir(mode=0o700)
    archive = directory / "database.dump"
    # Reserve a private file before pg_dump opens it; never pass a password in argv.
    with archive.open("xb"):
        archive.chmod(0o600)
    parsed = make_url(url)
    environment = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    environment.update(
        {
            "PGHOST": parsed.host or "",
            "PGPORT": str(parsed.port or 5432),
            "PGDATABASE": parsed.database or "",
            "PGUSER": parsed.username or "",
            "PGPASSWORD": parsed.password or "",
            "PGCONNECT_TIMEOUT": "5",
        }
    )
    try:
        process = subprocess.run(
            [
                executable,
                "--format=custom",
                "--no-owner",
                "--no-privileges",
                "--schema",
                schema,
                "--file",
                str(archive),
            ],
            env=environment,
            capture_output=True,
            timeout=45,
            check=False,
        )
        verified = subprocess.run(
            [inspector, "--list", str(archive)],
            capture_output=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise SeedError("Backup failed; database has not been changed") from None
    if process.returncode or verified.returncode or archive.stat().st_size == 0:
        raise SeedError("Backup failed validation; database has not been changed")
    metadata = {
        "created_at": datetime.now(UTC).isoformat(),
        "database": parsed.database,
        "schema": schema,
        "counts": before,
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "photos": "Original private photo files are retained; this dump stores their references.",
    }
    (directory / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    for name in ("demo-credentials.txt", "industrial-credentials.txt"):
        credential = ROOT / "var" / name
        if schema == "public" and credential.is_file():
            shutil.copyfile(credential, directory / name)
            (directory / name).chmod(0o600)
    return archive


async def maintain(
    database: Database,
    *,
    action: str,
    environment: str,
    dataset: dict[str, list[dict[str, Any]]] | None = None,
    anchor: date | None = None,
    seed: int = 2026,
    secret: str = "",
) -> Result:
    if action not in {"apply", "replace", "clear"}:
        raise SeedError("Unknown action")
    url = database.engine.url.render_as_string(hide_password=False)
    schema = validate_target(url, environment)
    run_id = identity(anchor, seed) if anchor else None
    password_hash = None
    if action != "clear":
        if dataset is None or anchor is None:
            raise SeedError("A dataset and anchor are required")
        if not dataset.get("work_orders") or any(
            row.get("is_synthetic") is not True for row in dataset["work_orders"]
        ):
            raise SeedError("Generated orders must retain synthetic provenance")
        if set(dataset) - set(Base.metadata.tables) or "seed_runs" in dataset:
            raise SeedError("Unknown or reserved dataset table")
        try:
            password_hash = hash_secret(secret)
        except ValueError as error:
            raise SeedError(str(error)) from None
    table_sql = ", ".join(f'"{schema}"."{t.name}"' for t in Base.metadata.sorted_tables)
    backup = None
    async with database.sessions.begin() as session:
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": LOCK_KEY})
        # EXCLUSIVE blocks all writers but permits pg_dump's ACCESS SHARE locks.
        # Backup and reset thus observe the same state; failure rolls back the reset.
        await session.execute(text(f"LOCK TABLE {table_sql} IN EXCLUSIVE MODE"))
        before = await counts(session)
        runs = list(await session.scalars(select(SeedRun.id)))
        if action == "apply" and runs == [run_id]:
            return Result(changed=False, counts=before)
        if action == "apply" and any(before.values()):
            raise SeedError("Apply requires an empty database; use explicit replace with backup")
        if action == "clear":
            if not any(before.values()):
                return Result(changed=False, counts=before)
            if len(runs) != 1 or not runs[0].startswith(PREFIX):
                raise SeedError("Clear only removes a database owned by the industrial seed")
            real_order = await session.scalar(
                select(WorkOrder.id).where(WorkOrder.is_synthetic.is_(False)).limit(1)
            )
            if real_order:
                raise SeedError("New non-seed orders exist; clear refused to preserve your work")
            from .generator import generate_dataset

            run = await session.get(SeedRun, runs[0])
            assert run is not None
            expected = generate_dataset(
                anchor=datetime.combine(run.anchor_date, time(12), tzinfo=UTC), seed=run.seed
            )
            # Operational auth/inbox/audit rows may evolve during a walkthrough. Catalogs
            # and orders added by the user must never be mistaken for the removable seed.
            managed = {
                "areas",
                "brigades",
                "equipment",
                "employees",
                "employee_areas",
                "fault_codes",
                "materials",
                "time_norms",
                "work_orders",
            }
            for name in managed:
                table = Base.metadata.tables[name]
                keys = list(table.primary_key.columns)
                actual_ids = set((await session.execute(select(*keys))).all())
                expected_ids = {tuple(row[key.name] for key in keys) for row in expected[name]}
                if actual_ids - expected_ids:
                    raise SeedError(f"New non-seed records exist in {name}; clear refused")
        if action in {"replace", "clear"} and any(before.values()):
            backup = await asyncio.to_thread(_backup, url, schema, before)
            # No CASCADE: unexpected external references must block and roll back.
            await session.execute(text(f"TRUNCATE TABLE {table_sql} RESTART IDENTITY"))
        if action != "clear":
            assert dataset is not None and anchor is not None and run_id is not None
            for table in Base.metadata.sorted_tables:
                rows = dataset.get(table.name, [])
                if table.name == "employees":
                    rows = [row | {"password_hash": password_hash} for row in rows]
                if rows:
                    await session.execute(insert(table), rows)
            session.add(
                SeedRun(id=run_id, seed=seed, anchor_date=anchor, created_at=datetime.now(UTC))
            )
            await session.flush()
        after = await counts(session)
    return Result(changed=True, counts=after, backup=backup)
