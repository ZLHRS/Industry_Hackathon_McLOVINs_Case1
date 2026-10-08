"""Read models scoped to the authenticated employee; no workflow mutations."""

from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import Decimal
from math import isfinite
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import case, func, or_, select, text

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
    ai_share_allowed: bool
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


class FeedbackRecommendation(BaseModel):
    """Executor-safe, human-readable result of one completed check."""

    title: str
    detail: str
    status: Literal["pass", "warning", "fail", "unknown"]


class FeedbackTiming(BaseModel):
    active_minutes: float | None
    paused_minutes: float | None
    elapsed_minutes: float | None
    norm_minutes: float | None
    difference_minutes: float | None
    percent_of_norm: float | None


class ExecutorFeedback(BaseModel):
    """Sanitized assessment history for the executor assigned to this order."""

    submission_version: int
    attempt: int | None
    verdict: str | None
    score: int | None
    master_score: int | None
    effective_score: int | None
    needs_master_review: bool
    reviewed_at: datetime
    is_current: bool
    recommendations: list[FeedbackRecommendation]
    timing: FeedbackTiming


class OrderDetail(OrderView):
    master_name: str
    executor_name: str
    work_description: str | None
    fault_code_id: UUID | None
    no_materials_reason: str | None
    materials: list[MaterialView]
    photos: list[PhotoView]
    reviews: list[ReviewView]
    ai_job: AiJobView | None
    executor_feedback: list[ExecutorFeedback]


class EventView(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    sequence: int
    order_version: int | None
    actor_id: UUID | None
    actor_role: str
    actor_display_name: str
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
    attention_count: int = 0


class MasterOption(BaseModel):
    """A safe, area-scoped option for the work-order master filter."""

    id: UUID
    display_name: str


OrderSort = Literal["priority", "deadline", "newest", "oldest"]


class WorkloadView(BaseModel):
    employee_id: UUID
    area_ids: list[UUID] = Field(default_factory=list)
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


def _safe_feedback_number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
        return None
    if value < 0 or value > 1_000_000:
        return None
    return float(value)


def _executor_feedback(
    review: AIReview, *, attempt: int | None, is_current: bool
) -> ExecutorFeedback:
    """Project an allowlisted subset of a provider report for its repair author."""

    report = review.report if isinstance(review.report, dict) else {}
    recommendations: list[FeedbackRecommendation] = []
    checks = report.get("checks")
    if isinstance(checks, list):
        for check in checks:
            if not isinstance(check, dict):
                continue
            title, detail, status = check.get("title"), check.get("detail"), check.get("status")
            if (
                isinstance(title, str)
                and 0 < len(title) <= 160
                and isinstance(detail, str)
                and 0 < len(detail) <= 600
                and status in {"pass", "warning", "fail", "unknown"}
            ):
                recommendations.append(
                    FeedbackRecommendation(title=title, detail=detail, status=status)
                )

    raw_timing = report.get("timing")
    timing: dict[str, Any] = raw_timing if isinstance(raw_timing, dict) else {}
    active = _safe_feedback_number(timing.get("active_minutes"))
    norm = _safe_feedback_number(timing.get("norm_minutes"))
    difference = active - norm if active is not None and norm is not None else None
    percent = (active / norm * 100) if active is not None and norm and norm > 0 else None
    return ExecutorFeedback(
        submission_version=review.order_version,
        attempt=attempt,
        verdict=None if review.verdict is None else review.verdict.value,
        score=review.score,
        master_score=review.master_score,
        effective_score=review.master_score if review.master_score is not None else review.score,
        needs_master_review=review.needs_master_review,
        reviewed_at=review.created_at,
        is_current=is_current,
        recommendations=recommendations,
        timing=FeedbackTiming(
            active_minutes=active,
            paused_minutes=_safe_feedback_number(timing.get("paused_minutes")),
            elapsed_minutes=_safe_feedback_number(timing.get("elapsed_minutes")),
            norm_minutes=norm,
            difference_minutes=difference,
            percent_of_norm=percent,
        ),
    )


async def list_orders(
    database: Database,
    principal: Principal,
    *,
    statuses: list[WorkOrderStatus] | None = None,
    area_id: UUID | None = None,
    equipment_id: UUID | None = None,
    executor_id: UUID | None = None,
    master_id: UUID | None = None,
    priority: Priority | None = None,
    work_type: WorkType | None = None,
    overdue: bool | None = None,
    q: str | None = None,
    attention: bool = False,
    sort: OrderSort = "priority",
    offset: int = 0,
    limit: int = 50,
) -> OrderPage:
    now = datetime.now(UTC)
    predicates = [visible_orders(principal)]
    if master_id is not None:
        if principal.role == "executor":
            # An executor may narrow their own orders by actual issuer only.
            # The same visibility predicate makes known-but-invisible and
            # unknown master UUIDs indistinguishable.
            master_is_scoped = select(WorkOrder.id).where(
                visible_orders(principal), WorkOrder.master_id == master_id
            )
        else:
            # A master or manager filter may only name a master visible from at least one
            # of the caller's areas. Inactive masters stay available for historical and
            # archived orders; the scope check still prevents UUID probing across sites.
            master_is_scoped = (
                select(Employee.id)
                .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
                .where(
                    Employee.id == master_id,
                    Employee.role == "master",
                    EmployeeArea.area_id.in_(principal.area_ids),
                )
            )
        predicates.append(WorkOrder.master_id == master_id)
    if q and (query := q.strip()):
        # Search before paging and aggregation, with literal user input and the same RBAC scope.
        machines = select(Equipment.id).where(
            or_(
                Equipment.name.icontains(query, autoescape=True),
                Equipment.inventory_number.icontains(query, autoescape=True),
            )
        )
        predicates.append(
            or_(
                WorkOrder.number.icontains(query, autoescape=True),
                WorkOrder.description.icontains(query, autoescape=True),
                WorkOrder.equipment_id.in_(machines),
            )
        )
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
    condition = (WorkOrder.deadline < now) & WorkOrder.status.not_in(
        [
            WorkOrderStatus.REJECTED,
            WorkOrderStatus.COMPLETED,
            WorkOrderStatus.AI_REVIEW,
            WorkOrderStatus.CLOSED,
            WorkOrderStatus.CANCELLED,
        ]
    )
    needs_attention = WorkOrder.status.not_in(
        [WorkOrderStatus.REJECTED, WorkOrderStatus.CLOSED, WorkOrderStatus.CANCELLED]
    ) & (WorkOrder.priority.in_([Priority.EMERGENCY, Priority.HIGH]) | condition)
    if overdue is not None:
        predicates.append(condition if overdue else ~condition)
    if attention:
        predicates.append(needs_attention)
    priority_ordering = case(
        (WorkOrder.priority == Priority.EMERGENCY, 0),
        (WorkOrder.priority == Priority.HIGH, 1),
        (WorkOrder.priority == Priority.NORMAL, 2),
        else_=3,
    )
    orders_query = select(WorkOrder).where(*predicates)
    if sort == "priority":
        orders_query = orders_query.order_by(
            priority_ordering, WorkOrder.deadline, WorkOrder.issued_at, WorkOrder.id
        )
    elif sort == "deadline":
        orders_query = orders_query.order_by(WorkOrder.deadline, WorkOrder.id)
    elif sort == "newest":
        orders_query = orders_query.order_by(WorkOrder.issued_at.desc(), WorkOrder.id)
    else:
        orders_query = orders_query.order_by(WorkOrder.issued_at, WorkOrder.id)
    async with database.sessions.begin() as session:
        # Counts and page refer to one snapshot even while another client changes a status.
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        if master_id is not None and await session.scalar(master_is_scoped) is None:
            raise OperationError(404, "master_not_found")
        counts = {status.value: 0 for status in WorkOrderStatus}
        rows = await session.execute(
            select(WorkOrder.status, func.count()).where(*predicates).group_by(WorkOrder.status)
        )
        counts.update({status.value: count for status, count in rows})
        attention_count = await session.scalar(
            select(func.count()).select_from(WorkOrder).where(*predicates, needs_attention)
        )
        orders = await session.scalars(orders_query.offset(offset).limit(limit))
        return OrderPage(
            items=[order_view(row, now) for row in orders],
            total=sum(counts.values()),
            counts=counts,
            offset=offset,
            limit=limit,
            attention_count=attention_count or 0,
        )


async def master_options(database: Database, principal: Principal) -> list[MasterOption]:
    """List masters a caller may use to narrow their visible work orders."""

    ensure_role(principal, "master", "manager", "executor")
    if principal.role == "executor":
        query = (
            select(Employee.id, Employee.display_name)
            .join(WorkOrder, WorkOrder.master_id == Employee.id)
            .where(visible_orders(principal))
        )
    else:
        query = (
            select(Employee.id, Employee.display_name)
            .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
            .where(
                Employee.role == "master",
                EmployeeArea.area_id.in_(principal.area_ids),
            )
        )
    async with database.sessions() as session:
        rows = await session.execute(query.distinct().order_by(Employee.display_name, Employee.id))
        return [
            MasterOption(id=employee_id, display_name=display_name)
            for employee_id, display_name in rows
        ]


async def order_detail(database: Database, principal: Principal, order_id: UUID) -> OrderDetail:
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        order = await get_order(session, order_id, principal)
        participants = {
            employee_id: display_name
            for employee_id, display_name in (
                await session.execute(
                    select(Employee.id, Employee.display_name).where(
                        Employee.id.in_([order.master_id, order.executor_id])
                    )
                )
            ).all()
        }
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
        executor_feedback: list[ExecutorFeedback] = []
        if principal.role == "executor":
            own_submissions = select(WorkOrderEvent.order_version).where(
                WorkOrderEvent.work_order_id == order_id,
                WorkOrderEvent.action == "complete",
                WorkOrderEvent.actor_id == principal.employee_id,
                WorkOrderEvent.order_version.is_not(None),
            )
            executor_reviews = (
                await session.scalars(
                    select(AIReview)
                    .where(
                        AIReview.work_order_id == order_id,
                        AIReview.order_version.in_(own_submissions),
                    )
                    .order_by(AIReview.created_at, AIReview.id)
                )
            ).all()
            submission_attempts = {
                event.order_version: event.details.get("attempt")
                for event in (
                    await session.scalars(
                        select(WorkOrderEvent)
                        .where(
                            WorkOrderEvent.work_order_id == order_id,
                            WorkOrderEvent.action == "complete",
                        )
                        .order_by(WorkOrderEvent.sequence)
                    )
                ).all()
                if event.order_version is not None
                and isinstance(event.details.get("attempt"), int)
                and not isinstance(event.details.get("attempt"), bool)
                and event.details["attempt"] > 0
            }
            executor_feedback = [
                _executor_feedback(
                    review,
                    attempt=submission_attempts.get(
                        review.order_version,
                        order.attempt
                        if review.order_version == order.last_submission_version
                        else None,
                    ),
                    is_current=order.last_submission_version == review.order_version,
                )
                for review in executor_reviews
            ]
        else:
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
            master_name=participants[order.master_id],
            executor_name=participants[order.executor_id],
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
                    ai_share_allowed=p.ai_share_allowed,
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
            executor_feedback=executor_feedback,
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
            await session.execute(
                select(WorkOrderEvent, Employee.display_name)
                .outerjoin(Employee, Employee.id == WorkOrderEvent.actor_id)
                .where(*predicates)
                .order_by(WorkOrderEvent.sequence)
                .limit(limit + 1)
            )
        ).all()

        def event_view(event: WorkOrderEvent, display_name: str | None) -> EventView:
            actor_display_name = display_name or (
                "Система" if event.actor_id is None else "Недоступный сотрудник"
            )
            view = EventView(
                id=event.id,
                sequence=event.sequence,
                order_version=event.order_version,
                actor_id=event.actor_id,
                actor_role=event.actor_role.value,
                actor_display_name=actor_display_name,
                action=event.action,
                from_status=None if event.from_status is None else event.from_status.value,
                to_status=event.to_status.value,
                occurred_at=event.occurred_at,
                reason=event.reason,
                details=event.details,
            )
            return view.model_copy(update={"details": {}}) if principal.role == "executor" else view

        return EventPage(
            items=[event_view(event, display_name) for event, display_name in rows[:limit]],
            next_after=rows[limit - 1][0].sequence if len(rows) > limit else None,
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
        memberships: dict[UUID, list[UUID]] = {person.id: [] for person in people}
        for employee_id, permitted_area in (
            await session.execute(
                select(EmployeeArea.employee_id, EmployeeArea.area_id)
                .where(
                    EmployeeArea.employee_id.in_(memberships),
                    EmployeeArea.area_id.in_(scopes),
                )
                .order_by(EmployeeArea.area_id)
            )
        ).all():
            memberships[employee_id].append(permitted_area)
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
                    area_ids=memberships[person.id],
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
