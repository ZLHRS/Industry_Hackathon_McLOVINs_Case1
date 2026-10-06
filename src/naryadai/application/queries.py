"""Read models scoped to the authenticated employee; no workflow mutations."""

from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from sqlalchemy import case, func, select, text

from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import LifecycleState, WorkOrderStatus, is_overdue
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    AIReview,
    AIReviewJob,
    Employee,
    EmployeeArea,
    Equipment,
    Material,
    MaterialUsage,
    Photo,
    Priority,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

from .common import OperationError, ensure_role, get_order, visible_orders

# Automated assessments and master-only factual observations are operationally
# useful, but are not part of an executor's repair history. Keep this list
# compatible with the earlier event spellings present in imported data.
_EXECUTOR_HIDDEN_EVENT_ACTIONS = frozenset(
    {
        "start_ai_review",
        "record_ai_assessment",
        "mark_rework",
        "ai_review",
        "ai_accepted",
        "ai_rework",
        "manual_review",
        "record_downtime",
        "adjudicate_refusal",
    }
)


class OrderView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    number: str
    work_type: WorkType
    description: str
    area_id: UUID
    equipment_id: UUID
    executor_id: UUID
    master_id: UUID
    priority: Priority
    status: WorkOrderStatus
    issued_at: datetime
    deadline: datetime
    started_at: datetime | None
    completed_at: datetime | None
    closed_at: datetime | None
    comment: str | None
    version: int
    attempt: int
    last_submission_version: int | None
    is_synthetic: bool
    overdue: bool = False


class MaterialView(BaseModel):
    id: UUID
    material_id: UUID
    name: str
    unit: str
    quantity: Decimal
    submission_version: int | None


class PhotoView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    kind: str
    attempt: int
    uploaded_at: datetime
    captured_at: datetime | None
    author_id: UUID
    sha256: str
    size_bytes: int
    content_url: str


class ReviewView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    order_version: int
    verdict: str | None
    score: int | None
    needs_master_review: bool
    explanation: str
    model_name: str
    created_at: datetime
    master_score: int | None
    report: dict[str, Any]
    is_current: bool = False


class AiJobView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    status: str
    attempts: int
    next_attempt_at: datetime
    last_error_code: str | None


class OrderDetail(OrderView):
    work_description: str | None
    fault_code_id: UUID | None
    no_materials_reason: str | None
    materials: list[MaterialView]
    photos: list[PhotoView]
    reviews: list[ReviewView]
    ai_job: AiJobView | None


class EventView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    sequence: int
    order_version: int | None
    actor_id: UUID | None
    actor_role: str
    action: str
    from_status: str | None
    to_status: str
    occurred_at: datetime
    reason: str | None
    details: dict[str, Any]


class EventPage(BaseModel):
    items: list[EventView]
    next_after: int | None


class OrderPage(BaseModel):
    items: list[OrderView]
    total: int
    counts: dict[str, int]
    offset: int
    limit: int


class WorkloadView(BaseModel):
    employee_id: UUID
    display_name: str
    specialty: str
    grade: int
    brigade_id: UUID | None
    is_on_shift: bool
    availability: Literal["free", "busy", "queued", "off_shift"]
    current_order_id: UUID | None
    current_order_number: str | None
    current_started_at: datetime | None
    queue_length: int
    paused_count: int


def order_view(order: WorkOrder, now: datetime) -> OrderView:
    view = OrderView.model_validate(order)
    return view.model_copy(
        update={
            "overdue": is_overdue(LifecycleState(order.status), deadline=order.deadline, at=now)
        }
    )


async def list_orders(
    database: Database,
    principal: Principal,
    *,
    statuses: list[WorkOrderStatus] | None = None,
    area_id: UUID | None = None,
    equipment_id: UUID | None = None,
    executor_id: UUID | None = None,
    priority: Priority | None = None,
    work_type: WorkType | None = None,
    overdue: bool | None = None,
    offset: int = 0,
    limit: int = 50,
) -> OrderPage:
    now = datetime.now(UTC)
    predicates = [visible_orders(principal)]
    for column, value in (
        (WorkOrder.area_id, area_id),
        (WorkOrder.equipment_id, equipment_id),
        (WorkOrder.executor_id, executor_id),
        (WorkOrder.priority, priority),
        (WorkOrder.work_type, work_type),
    ):
        if value is not None:
            predicates.append(column == value)
    if statuses:
        predicates.append(WorkOrder.status.in_(statuses))
    if overdue is not None:
        condition = (WorkOrder.deadline < now) & WorkOrder.status.not_in(
            [
                WorkOrderStatus.REJECTED,
                WorkOrderStatus.COMPLETED,
                WorkOrderStatus.AI_REVIEW,
                WorkOrderStatus.CLOSED,
                WorkOrderStatus.CANCELLED,
            ]
        )
        predicates.append(condition if overdue else ~condition)
    ordering = case(
        (WorkOrder.priority == Priority.EMERGENCY, 0),
        (WorkOrder.priority == Priority.HIGH, 1),
        (WorkOrder.priority == Priority.NORMAL, 2),
        else_=3,
    )
    async with database.sessions.begin() as session:
        # Counts and page refer to one snapshot even while another client changes a status.
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        counts = {status.value: 0 for status in WorkOrderStatus}
        rows = await session.execute(
            select(WorkOrder.status, func.count()).where(*predicates).group_by(WorkOrder.status)
        )
        counts.update({status.value: count for status, count in rows})
        orders = await session.scalars(
            select(WorkOrder)
            .where(*predicates)
            .order_by(ordering, WorkOrder.deadline, WorkOrder.issued_at, WorkOrder.id)
            .offset(offset)
            .limit(limit)
        )
        return OrderPage(
            items=[order_view(row, now) for row in orders],
            total=sum(counts.values()),
            counts=counts,
            offset=offset,
            limit=limit,
        )


async def order_detail(database: Database, principal: Principal, order_id: UUID) -> OrderDetail:
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        order = await get_order(session, order_id, principal)
        materials = await session.execute(
            select(MaterialUsage, Material)
            .join(Material, Material.id == MaterialUsage.material_id)
            .where(MaterialUsage.work_order_id == order_id)
            .order_by(MaterialUsage.id)
        )
        photos = (
            await session.scalars(
                select(Photo)
                .where(Photo.work_order_id == order_id)
                .order_by(Photo.uploaded_at, Photo.id)
            )
        ).all()
        reviews: Sequence[AIReview] = ()
        job: AIReviewJob | None = None
        if principal.role != "executor":
            reviews = (
                await session.scalars(
                    select(AIReview)
                    .where(AIReview.work_order_id == order_id)
                    .order_by(AIReview.created_at, AIReview.id)
                )
            ).all()
            if order.last_submission_version is not None:
                job = await session.scalar(
                    select(AIReviewJob).where(
                        AIReviewJob.work_order_id == order_id,
                        AIReviewJob.submission_version == order.last_submission_version,
                    )
                )
        return OrderDetail(
            **order_view(order, datetime.now(UTC)).model_dump(),
            work_description=order.work_description,
            fault_code_id=order.fault_code_id,
            no_materials_reason=order.no_materials_reason,
            materials=[
                MaterialView(
                    id=usage.id,
                    material_id=material.id,
                    name=material.name,
                    unit=material.unit,
                    quantity=usage.quantity,
                    submission_version=usage.submission_version,
                )
                for usage, material in materials
            ],
            photos=[
                PhotoView(
                    id=p.id,
                    kind=p.kind,
                    attempt=p.attempt,
                    uploaded_at=p.uploaded_at,
                    captured_at=p.captured_at,
                    author_id=p.author_id,
                    sha256=p.sha256,
                    size_bytes=p.size_bytes,
                    content_url=f"/api/v1/work-orders/{order_id}/photos/{p.id}",
                )
                for p in photos
            ],
            reviews=[
                ReviewView.model_validate(r).model_copy(
                    update={
                        "is_current": order.last_submission_version == r.order_version,
                    }
                )
                for r in reviews
            ],
            ai_job=None if job is None else AiJobView.model_validate(job),
        )


async def order_events(
    database: Database,
    principal: Principal,
    order_id: UUID,
    *,
    after_sequence: int = 0,
    limit: int = 100,
) -> EventPage:
    async with database.sessions() as session:
        await get_order(session, order_id, principal)
        predicates = [
            WorkOrderEvent.work_order_id == order_id,
            WorkOrderEvent.sequence > after_sequence,
        ]
        if principal.role == "executor":
            predicates.append(WorkOrderEvent.action.not_in(_EXECUTOR_HIDDEN_EVENT_ACTIONS))
        rows = (
            await session.scalars(
                select(WorkOrderEvent)
                .where(*predicates)
                .order_by(WorkOrderEvent.sequence)
                .limit(limit + 1)
            )
        ).all()
        return EventPage(
            items=[
                EventView.model_validate(r).model_copy(update={"details": {}})
                if principal.role == "executor"
                else EventView.model_validate(r)
                for r in rows[:limit]
            ],
            next_after=rows[limit - 1].sequence if len(rows) > limit else None,
        )


async def equipment_history(
    database: Database, principal: Principal, equipment_id: UUID, *, offset: int, limit: int
) -> OrderPage:
    ensure_role(principal, "master", "manager")
    async with database.sessions() as session:
        machine = await session.get(Equipment, equipment_id)
        if machine is None or machine.area_id not in principal.area_ids:
            raise OperationError(404, "equipment_not_found")
    return await list_orders(
        database, principal, equipment_id=equipment_id, offset=offset, limit=limit
    )


async def workload(
    database: Database,
    principal: Principal,
    *,
    area_id: UUID | None = None,
    offset: int = 0,
    limit: int = 100,
) -> list[WorkloadView]:
    ensure_role(principal, "master", "manager", "executor")
    if area_id is not None and area_id not in principal.area_ids:
        raise OperationError(404, "area_not_found")
    scopes = (area_id,) if area_id is not None else principal.area_ids
    query = select(Employee).where(
        Employee.role == "executor",
        Employee.is_active.is_(True),
        Employee.id.in_(select(EmployeeArea.employee_id).where(EmployeeArea.area_id.in_(scopes))),
    )
    if principal.role == "executor":
        query = query.where(Employee.id == principal.employee_id)
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        people = (
            await session.scalars(
                query.order_by(Employee.display_name, Employee.id).offset(offset).limit(limit)
            )
        ).all()
        # Include all their running jobs for truthful availability, but never reveal
        # an inaccessible order id/number or queue count across another area.
        jobs = (
            await session.scalars(
                select(WorkOrder).where(
                    WorkOrder.executor_id.in_([p.id for p in people]),
                    WorkOrder.status.in_(
                        ["issued", "accepted", "queued", "in_progress", "paused", "rework"]
                    ),
                )
            )
        ).all()
        result = []
        for person in people:
            own = [o for o in jobs if o.executor_id == person.id]
            running = next((o for o in own if o.status == WorkOrderStatus.IN_PROGRESS), None)
            visible = [o for o in own if o.area_id in scopes]
            waiting = sum(o.status != WorkOrderStatus.IN_PROGRESS for o in visible)
            current = running if running is not None and running.area_id in scopes else None
            availability: Literal["free", "busy", "queued", "off_shift"]
            if not person.is_on_shift:
                availability = "off_shift"
            elif running is not None:
                availability = "busy"
            elif waiting:
                availability = "queued"
            else:
                availability = "free"
            result.append(
                WorkloadView(
                    employee_id=person.id,
                    display_name=person.display_name,
                    specialty=person.specialty,
                    grade=person.grade,
                    brigade_id=person.brigade_id,
                    is_on_shift=person.is_on_shift,
                    availability=availability,
                    current_order_id=current.id if current else None,
                    current_order_number=current.number if current else None,
                    current_started_at=current.started_at if current else None,
                    queue_length=waiting,
                    paused_count=sum(o.status == WorkOrderStatus.PAUSED for o in visible),
                )
            )
        return result
