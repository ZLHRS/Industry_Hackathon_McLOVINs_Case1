"""Bounded immutable read snapshot; no external IO while a transaction is open."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import select, text

from naryadai.application.common import OperationError
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    AIReview,
    Area,
    Brigade,
    Employee,
    Equipment,
    FaultCode,
    Material,
    MaterialUsage,
    TimeNorm,
    WorkOrder,
    WorkOrderEvent,
)

from .history import EventMap, group_events


@dataclass(frozen=True)
class Snapshot:
    orders: list[WorkOrder]
    events: EventMap
    reviews: list[AIReview]
    usages: list[tuple[MaterialUsage, Material]]
    employees: dict[UUID, Employee]
    equipment: dict[UUID, Equipment]
    areas: dict[UUID, Area]
    brigades: dict[UUID, Brigade]
    faults: dict[UUID, FaultCode]
    norms: dict[tuple[UUID, str], int]


async def load_snapshot(
    database: Database,
    area_ids: tuple[UUID, ...],
    equipment_ids: tuple[UUID, ...],
    until: datetime,
    now: datetime,
) -> Snapshot:
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        query = select(WorkOrder).where(
            WorkOrder.area_id.in_(area_ids), WorkOrder.issued_at < until, WorkOrder.issued_at <= now
        )
        if equipment_ids:
            query = query.where(WorkOrder.equipment_id.in_(equipment_ids))
        orders = list(
            await session.scalars(query.order_by(WorkOrder.issued_at, WorkOrder.id).limit(20001))
        )
        if len(orders) > 20000:
            raise OperationError(413, "analytics_row_limit_exceeded")
        ids = [o.id for o in orders]
        event_rows = list(
            await session.scalars(
                select(WorkOrderEvent)
                .where(WorkOrderEvent.work_order_id.in_(ids), WorkOrderEvent.occurred_at <= now)
                .order_by(WorkOrderEvent.occurred_at, WorkOrderEvent.sequence)
                .limit(200001)
            )
        )
        reviews = list(
            await session.scalars(
                select(AIReview)
                .where(AIReview.work_order_id.in_(ids), AIReview.created_at <= now)
                .limit(50001)
            )
        )
        usage_rows = (
            await session.execute(
                select(MaterialUsage, Material)
                .join(Material, Material.id == MaterialUsage.material_id)
                .where(MaterialUsage.work_order_id.in_(ids))
                .limit(100001)
            )
        ).all()
        if len(event_rows) > 200000 or len(reviews) > 50000 or len(usage_rows) > 100000:
            raise OperationError(413, "analytics_evidence_limit_exceeded")
        person_ids = {o.executor_id for o in orders} | {
            e.actor_id for e in event_rows if e.actor_id
        }
        employees = {
            p.id: p
            for p in await session.scalars(select(Employee).where(Employee.id.in_(person_ids)))
        }
        equipment = {
            e.id: e
            for e in await session.scalars(
                select(Equipment).where(Equipment.id.in_({o.equipment_id for o in orders}))
            )
        }
        areas = {a.id: a for a in await session.scalars(select(Area).where(Area.id.in_(area_ids)))}
        brigades = {
            b.id: b
            for b in await session.scalars(
                select(Brigade).where(
                    Brigade.id.in_({p.brigade_id for p in employees.values() if p.brigade_id})
                )
            )
        }
        faults = {
            f.id: f
            for f in await session.scalars(
                select(FaultCode).where(
                    FaultCode.id.in_({o.fault_code_id for o in orders if o.fault_code_id})
                )
            )
        }
        norms = {
            (n.fault_code_id, n.equipment_type): n.minutes
            for n in await session.scalars(
                select(TimeNorm).where(TimeNorm.fault_code_id.in_(faults))
            )
        }
    return Snapshot(
        orders,
        group_events(event_rows),
        reviews,
        [(u, m) for u, m in usage_rows],
        employees,
        equipment,
        areas,
        brigades,
        faults,
        norms,
    )
