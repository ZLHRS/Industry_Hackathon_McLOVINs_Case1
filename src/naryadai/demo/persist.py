"""Transactional persistence for the explicitly requested synthetic demo seed."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from hashlib import sha256
from typing import Final

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from naryadai.auth.security import hash_secret
from naryadai.domain.lifecycle import ActorRole, AiAssessment, WorkOrderStatus
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    AIReview,
    Area,
    AuthSession,
    Brigade,
    Employee,
    EmployeeArea,
    EmployeeRole,
    Equipment,
    FaultCode,
    LoginThrottle,
    Material,
    MaterialUsage,
    Photo,
    Priority,
    SeedRun,
    TimeNorm,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

from .generator import DemoDataset, generate_demo_dataset

_LOCK_KEY: Final = 5_437_891_113
_VERSION: Final = "demo-v1"


class SeedRefusalError(RuntimeError):
    """Raised when seeding could risk mixing fixtures with existing data."""


@dataclass(frozen=True, slots=True)
class SeedResult:
    """Stable counts suitable for a CLI summary without leaking credentials."""

    already_seeded: bool
    counts: dict[str, int]


def seed_run_id(*, anchor_date: date, seed: int) -> str:
    """Return a compact deterministic identity for one generator configuration."""
    payload = f"{_VERSION}:{anchor_date.isoformat()}:{seed}".encode()
    return sha256(payload).hexdigest()


async def seed_demo_database(
    database: Database,
    *,
    anchor_date: date,
    seed: int,
    secret: str,
    environment: str,
) -> SeedResult:
    """Persist one fixture into an empty non-production database exactly once.

    A transaction-level PostgreSQL advisory lock serializes concurrent invocations.
    A matching prior run is returned unchanged; any other data causes a rollback.
    """
    if environment == "production":
        raise SeedRefusalError("Demo seed is refused in production")
    if not secret:
        raise SeedRefusalError("NARYADAI_DEMO_SECRET is required")
    dataset = generate_demo_dataset(anchor_date=anchor_date, seed=seed)
    run_id = seed_run_id(anchor_date=anchor_date, seed=seed)
    counts = _counts(dataset)
    async with database.sessions.begin() as session:
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _LOCK_KEY})
        previous = await session.scalar(select(SeedRun).where(SeedRun.id == run_id))
        if previous is not None:
            if previous.seed != seed or previous.anchor_date != anchor_date:
                raise SeedRefusalError("Existing demo seed configuration does not match")
            return SeedResult(already_seeded=True, counts=await _database_counts(session))
        occupied = await _occupied_table_names(session)
        if occupied:
            names = ", ".join(occupied)
            raise SeedRefusalError(f"Demo seed requires an empty database; found data in: {names}")
        await _add_dataset(session, dataset, secret)
        session.add(
            SeedRun(
                id=run_id,
                seed=seed,
                anchor_date=anchor_date,
                created_at=datetime.now(UTC),
            )
        )
        await session.flush()
    return SeedResult(already_seeded=False, counts=counts)


async def _occupied_table_names(session: AsyncSession) -> tuple[str, ...]:
    """Return every nonempty application table; Alembic metadata is intentionally absent."""
    models = (
        Area,
        Brigade,
        Equipment,
        Employee,
        EmployeeArea,
        FaultCode,
        Material,
        TimeNorm,
        WorkOrder,
        WorkOrderEvent,
        MaterialUsage,
        AIReview,
        Photo,
        AuthSession,
        LoginThrottle,
        SeedRun,
    )
    names: list[str] = []
    for model in models:
        result = await session.scalar(select(func.count()).select_from(model))
        if result:
            names.append(model.__tablename__)
    return tuple(names)


async def _add_dataset(session: AsyncSession, dataset: DemoDataset, secret: str) -> None:
    """Stage parent records before children because mappings have no ORM relationships."""
    try:
        password_hash = hash_secret(secret)
    except ValueError as error:
        raise SeedRefusalError(str(error)) from error
    session.add_all(Area(**row) for row in dataset.areas)
    session.add_all(Brigade(**row) for row in dataset.brigades)
    await session.flush()

    session.add_all(Equipment(**row) for row in dataset.equipment)
    session.add_all(
        Employee(**(row | {"role": EmployeeRole(row["role"]), "password_hash": password_hash}))
        for row in dataset.employees
    )
    session.add_all(FaultCode(**row) for row in dataset.fault_codes)
    session.add_all(Material(**row) for row in dataset.materials)
    await session.flush()

    session.add_all(EmployeeArea(**row) for row in dataset.employee_areas)
    session.add_all(TimeNorm(**row) for row in dataset.time_norms)
    await session.flush()

    session.add_all(
        WorkOrder(
            **(
                row
                | {
                    "work_type": WorkType(row["work_type"]),
                    "priority": Priority(row["priority"]),
                    "status": WorkOrderStatus(row["status"]),
                }
            )
        )
        for row in dataset.work_orders
    )
    await session.flush()

    session.add_all(
        WorkOrderEvent(
            **(
                row
                | {
                    "actor_role": ActorRole(row["actor_role"]),
                    "from_status": WorkOrderStatus(row["from_status"])
                    if row["from_status"]
                    else None,
                    "to_status": WorkOrderStatus(row["to_status"]),
                }
            )
        )
        for row in dataset.events
    )
    session.add_all(MaterialUsage(**row) for row in dataset.material_usages)
    session.add_all(
        AIReview(
            **(
                row
                | {
                    "verdict": AiAssessment(row["verdict"]) if row["verdict"] else None,
                }
            )
        )
        for row in dataset.ai_reviews
    )


async def _database_counts(session: AsyncSession) -> dict[str, int]:
    models = {
        "areas": Area,
        "brigades": Brigade,
        "equipment": Equipment,
        "employees": Employee,
        "employee_areas": EmployeeArea,
        "fault_codes": FaultCode,
        "materials": Material,
        "time_norms": TimeNorm,
        "work_orders": WorkOrder,
        "events": WorkOrderEvent,
        "material_usages": MaterialUsage,
        "ai_reviews": AIReview,
        "photos": Photo,
    }
    return {
        name: int(await session.scalar(select(func.count()).select_from(model)) or 0)
        for name, model in models.items()
    }


def _counts(dataset: DemoDataset) -> dict[str, int]:
    return {
        "areas": len(dataset.areas),
        "brigades": len(dataset.brigades),
        "equipment": len(dataset.equipment),
        "employees": len(dataset.employees),
        "employee_areas": len(dataset.employee_areas),
        "fault_codes": len(dataset.fault_codes),
        "materials": len(dataset.materials),
        "time_norms": len(dataset.time_norms),
        "work_orders": len(dataset.work_orders),
        "events": len(dataset.events),
        "material_usages": len(dataset.material_usages),
        "ai_reviews": len(dataset.ai_reviews),
        "photos": 0,
    }
