"""Read models scoped to the authenticated employee; no workflow mutations."""

from collections import defaultdict
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from math import isfinite
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import case, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from naryadai.analytics.data import Snapshot
from naryadai.analytics.history import group_events
from naryadai.analytics.ratings import final_submission_actor, latest_score
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import LifecycleState, WorkOrderStatus, is_overdue
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    AIReview,
    AIReviewJob,
    Area,
    Brigade,
    Employee,
    EmployeeArea,
    EmployeeRole,
    Equipment,
    FaultCode,
    Material,
    MaterialUsage,
    Photo,
    Priority,
    WorkOrder,
    WorkOrderEvent,
    WorkOrderParticipant,
    WorkType,
)

from .common import OperationError, ensure_role, get_order, visible_orders
from .suggestions import _fault_match

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
    brigade: "BrigadeAssignmentView | None" = None
    participants: list["ParticipantView"] = Field(default_factory=list)
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


class BrigadeAssignmentView(BaseModel):
    id: UUID
    code: str
    name: str


class ParticipantView(BaseModel):
    employee_id: UUID
    display_name: str
    role: Literal["responsible", "participant"]


class BrigadeOptionParticipant(BaseModel):
    employee_id: UUID
    display_name: str
    availability: Literal["free", "busy", "queued", "paused"]
    specialty: str | None = None
    grade: int = 0
    running_count: int = 0
    queue_length: int = 0
    paused_count: int = 0
    quality_score: float | None = None
    quality_sample_count: int = 0


class BrigadeOptionItem(BaseModel):
    brigade: BrigadeAssignmentView
    participant_ids: list[UUID]
    participants: list[BrigadeOptionParticipant]
    excluded_count: int
    suggested_responsible_id: UUID
    specialty_match: bool | None = None
    matching_specialists: int = 0
    quality_score: float | None = None
    quality_sample_count: int = 0
    reasons: list[str] = Field(default_factory=list)
    responsible_reasons: list[str] = Field(default_factory=list)
    recommended: bool = False


class BrigadeOptionsContext(BaseModel):
    specialty: str | None = None
    specialty_source: Literal["confirmed", "inferred", "unknown"] = "unknown"
    quality_history_days: int = 180
    quality_minimum: int = 3


class BrigadeOptionsView(BaseModel):
    items: list[BrigadeOptionItem]
    context: BrigadeOptionsContext = Field(default_factory=BrigadeOptionsContext)
    notes: list[str] = Field(default_factory=list)


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


def order_view(
    order: WorkOrder,
    now: datetime,
    *,
    brigade: BrigadeAssignmentView | None = None,
    participants: list[ParticipantView] | None = None,
) -> OrderView:
    view = OrderView.model_validate(order)
    return view.model_copy(
        update={
            "overdue": is_overdue(LifecycleState(order.status), deadline=order.deadline, at=now),
            "brigade": brigade,
            "participants": participants or [],
        }
    )


async def _assignment_views(
    session: AsyncSession, orders: Sequence[WorkOrder]
) -> dict[UUID, tuple[BrigadeAssignmentView | None, list[ParticipantView]]]:
    if not orders:
        return {}
    order_ids = [order.id for order in orders]
    brigade_ids = {order.brigade_id for order in orders if order.brigade_id is not None}
    brigades = (
        {
            row.id: BrigadeAssignmentView(id=row.id, code=row.code, name=row.name)
            for row in await session.scalars(select(Brigade).where(Brigade.id.in_(brigade_ids)))
        }
        if brigade_ids
        else {}
    )
    snapshots = list(
        await session.scalars(
            select(WorkOrderParticipant)
            .where(WorkOrderParticipant.work_order_id.in_(order_ids))
            .order_by(
                WorkOrderParticipant.work_order_id,
                WorkOrderParticipant.assignment_role.desc(),
                WorkOrderParticipant.employee_id,
            )
        )
    )
    grouped: dict[UUID, list[ParticipantView]] = {order.id: [] for order in orders}
    for item in snapshots:
        grouped[item.work_order_id].append(
            ParticipantView(
                employee_id=item.employee_id,
                display_name=item.display_name,
                role=item.assignment_role,
            )
        )
    legacy_ids = {order.executor_id for order in orders if not grouped[order.id]}
    people = (
        {
            row.id: row.display_name
            for row in await session.scalars(select(Employee).where(Employee.id.in_(legacy_ids)))
        }
        if legacy_ids
        else {}
    )
    for order in orders:
        if not grouped[order.id]:
            grouped[order.id] = [
                ParticipantView(
                    employee_id=order.executor_id,
                    display_name=people.get(order.executor_id, "Неизвестный исполнитель"),
                    role="responsible",
                )
            ]
    return {
        order.id: (
            None if order.brigade_id is None else brigades.get(order.brigade_id),
            grouped[order.id],
        )
        for order in orders
    }


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
        orders = list((await session.scalars(orders_query.offset(offset).limit(limit))).all())
        assignments = await _assignment_views(session, orders)
        return OrderPage(
            items=[
                order_view(
                    row,
                    now,
                    brigade=assignments[row.id][0],
                    participants=assignments[row.id][1],
                )
                for row in orders
            ],
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


_BRIGADE_HISTORY_DAYS = 180
_BRIGADE_QUALITY_MINIMUM = 3
_BRIGADE_MAX_HISTORY = 1_000
_ACTIVE_ASSIGNMENT_STATUSES = (
    WorkOrderStatus.ISSUED,
    WorkOrderStatus.ACCEPTED,
    WorkOrderStatus.QUEUED,
    WorkOrderStatus.IN_PROGRESS,
    WorkOrderStatus.PAUSED,
    WorkOrderStatus.REWORK,
)


def _specialty_key(value: str | None) -> str:
    return "" if value is None else " ".join(value.split()).casefold()


def _load_key(item: BrigadeOptionParticipant) -> tuple[int, int, int]:
    return item.running_count, item.paused_count, item.queue_length


async def _recommendation_context(
    session: AsyncSession,
    *,
    area_id: UUID,
    equipment_id: UUID | None,
    description: str | None,
    fault_code_id: UUID | None,
) -> tuple[BrigadeOptionsContext, Equipment | None, list[str]]:
    context = BrigadeOptionsContext()
    notes: list[str] = []
    if equipment_id is None:
        return context, None, notes
    equipment = await session.scalar(
        select(Equipment).where(Equipment.id == equipment_id, Equipment.area_id == area_id)
    )
    if equipment is None:
        raise OperationError(404, "equipment_not_found")
    if not equipment.is_active:
        raise OperationError(409, "equipment_inactive")
    if fault_code_id is not None:
        fault = await session.get(FaultCode, fault_code_id)
        if fault is None:
            raise OperationError(404, "fault_code_not_found")
        return (
            context.model_copy(
                update={"specialty": fault.specialty, "specialty_source": "confirmed"}
            ),
            equipment,
            notes,
        )
    if not description:
        return context, equipment, notes
    matches: list[tuple[int, FaultCode]] = []
    for fault in await session.scalars(select(FaultCode).order_by(FaultCode.code, FaultCode.id)):
        score, _ = _fault_match(fault, description)
        if score:
            matches.append((score, fault))
    if not matches:
        notes.append("По описанию не удалось определить специальность: выберите шифр вручную.")
        return context, equipment, notes
    top_score = max(score for score, _ in matches)
    top = [fault for score, fault in matches if score == top_score]
    if len(top) != 1:
        notes.append("Описание неоднозначно: специальность не выбрана автоматически.")
        return context, equipment, notes
    return (
        context.model_copy(update={"specialty": top[0].specialty, "specialty_source": "inferred"}),
        equipment,
        notes,
    )


async def brigade_options(
    database: Database,
    principal: Principal,
    area_id: UUID,
    *,
    equipment_id: UUID | None = None,
    description: str | None = None,
    fault_code_id: UUID | None = None,
) -> BrigadeOptionsView:
    """Return eligible brigades with deterministic, explainable planning evidence."""

    ensure_role(principal, "master")
    if area_id not in principal.area_ids:
        raise OperationError(404, "area_not_found")
    now = datetime.now(UTC)
    history_after = now - timedelta(days=_BRIGADE_HISTORY_DAYS)
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        area = await session.get(Area, area_id)
        if area is None:
            raise OperationError(404, "area_not_found")
        if not area.is_active:
            raise OperationError(409, "area_inactive")
        context, equipment, notes = await _recommendation_context(
            session,
            area_id=area_id,
            equipment_id=equipment_id,
            description=description,
            fault_code_id=fault_code_id,
        )
        eligible = list(
            await session.scalars(
                select(Employee)
                .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
                .where(
                    Employee.role == EmployeeRole.EXECUTOR,
                    Employee.is_active.is_(True),
                    Employee.is_on_shift.is_(True),
                    Employee.brigade_id.is_not(None),
                    EmployeeArea.area_id == area_id,
                )
                .order_by(Employee.brigade_id, Employee.display_name, Employee.id)
            )
        )
        eligible_ids = {employee.id for employee in eligible}
        loads: dict[UUID, list[int]] = defaultdict(lambda: [0, 0, 0])
        if eligible_ids:
            workload_rows = await session.execute(
                select(
                    WorkOrder.id,
                    WorkOrder.executor_id,
                    WorkOrder.status,
                    WorkOrderParticipant.employee_id,
                )
                .outerjoin(
                    WorkOrderParticipant,
                    WorkOrderParticipant.work_order_id == WorkOrder.id,
                )
                .where(
                    WorkOrder.status.in_(_ACTIVE_ASSIGNMENT_STATUSES),
                    (WorkOrder.executor_id.in_(eligible_ids))
                    | (WorkOrderParticipant.employee_id.in_(eligible_ids)),
                )
            )
            seen: set[tuple[UUID, UUID]] = set()
            for order_id, executor_id, status, participant_id in workload_rows:
                for employee_id in {executor_id, participant_id} & eligible_ids:
                    marker = (employee_id, order_id)
                    if marker in seen:
                        continue
                    seen.add(marker)
                    values = loads[employee_id]
                    if status is WorkOrderStatus.IN_PROGRESS:
                        values[0] += 1
                    elif status is WorkOrderStatus.PAUSED:
                        values[2] += 1
                    else:
                        values[1] += 1

        groups: dict[UUID, list[Employee]] = defaultdict(list)
        for employee in eligible:
            assert employee.brigade_id is not None
            groups[employee.brigade_id].append(employee)
        brigades = {
            brigade.id: brigade
            for brigade in await session.scalars(
                select(Brigade).where(Brigade.id.in_(groups)).order_by(Brigade.code, Brigade.id)
            )
        }
        all_members = {
            brigade_id: count
            for brigade_id, count in (
                await session.execute(
                    select(Employee.brigade_id, func.count())
                    .where(Employee.brigade_id.in_(groups))
                    .group_by(Employee.brigade_id)
                )
            ).all()
        }

        personal_scores: dict[UUID, list[int]] = defaultdict(list)
        brigade_scores: dict[UUID, list[int]] = defaultdict(list)
        if equipment is not None and groups:
            history_rows = list(
                await session.scalars(
                    select(WorkOrder)
                    .join(Equipment, Equipment.id == WorkOrder.equipment_id)
                    .where(
                        WorkOrder.area_id.in_(principal.area_ids),
                        WorkOrder.status == WorkOrderStatus.CLOSED,
                        WorkOrder.closed_at.is_not(None),
                        WorkOrder.closed_at >= history_after,
                        WorkOrder.closed_at <= now,
                        Equipment.equipment_type == equipment.equipment_type,
                    )
                    .order_by(WorkOrder.closed_at.desc(), WorkOrder.id)
                    .limit(_BRIGADE_MAX_HISTORY + 1)
                )
            )
            history_truncated = len(history_rows) > _BRIGADE_MAX_HISTORY
            history_orders = history_rows[:_BRIGADE_MAX_HISTORY]
            if history_truncated:
                notes.append(
                    f"Для качества учтены последние {_BRIGADE_MAX_HISTORY} закрытых работ за "
                    f"{_BRIGADE_HISTORY_DAYS} дней."
                )
            history_ids = [order.id for order in history_orders]
            events = (
                list(
                    await session.scalars(
                        select(WorkOrderEvent)
                        .where(WorkOrderEvent.work_order_id.in_(history_ids))
                        .order_by(WorkOrderEvent.work_order_id, WorkOrderEvent.sequence)
                    )
                )
                if history_ids
                else []
            )
            reviews = (
                list(
                    await session.scalars(
                        select(AIReview)
                        .where(AIReview.work_order_id.in_(history_ids))
                        .order_by(
                            AIReview.work_order_id, AIReview.order_version, AIReview.created_at
                        )
                    )
                )
                if history_ids
                else []
            )
            history = Snapshot(
                orders=history_orders,
                events=group_events(events),
                reviews=reviews,
                usages=[],
                employees={},
                equipment={},
                areas={},
                brigades={},
                faults={},
                norms={},
            )
            for order in history_orders:
                score = latest_score(order, history)
                if score is None:
                    continue
                actor = final_submission_actor(order, history)
                if actor in eligible_ids:
                    personal_scores[actor].append(score)
                if order.brigade_id in groups:
                    brigade_scores[order.brigade_id].append(score)

        items: list[BrigadeOptionItem] = []
        option_keys: dict[UUID, tuple[object, ...]] = {}
        required_specialty = _specialty_key(context.specialty)
        for brigade_id, people in groups.items():
            if len(people) < 2 or brigade_id not in brigades:
                continue
            members: list[BrigadeOptionParticipant] = []
            for person in people:
                running, queued, paused = loads[person.id]
                availability: Literal["free", "busy", "queued", "paused"] = (
                    "busy" if running else "paused" if paused else "queued" if queued else "free"
                )
                samples = personal_scores[person.id]
                members.append(
                    BrigadeOptionParticipant(
                        employee_id=person.id,
                        display_name=person.display_name,
                        availability=availability,
                        specialty=person.specialty,
                        grade=person.grade,
                        running_count=running,
                        queue_length=queued,
                        paused_count=paused,
                        quality_score=(
                            round(sum(samples) / len(samples), 2)
                            if len(samples) >= _BRIGADE_QUALITY_MINIMUM
                            else None
                        ),
                        quality_sample_count=len(samples),
                    )
                )
            matching = [
                member
                for member in members
                if required_specialty and _specialty_key(member.specialty) == required_specialty
            ]
            specialty_match = None if not required_specialty else bool(matching)
            ranked_members = matching if matching else members
            by_load = sorted({_load_key(member) for member in ranked_members})
            responsible = None
            quality_skipped = False
            for candidate_load in by_load:
                tied = [member for member in ranked_members if _load_key(member) == candidate_load]
                best_grade = max(member.grade for member in tied)
                tied = [member for member in tied if member.grade == best_grade]
                if len(tied) > 1 and all(member.quality_score is not None for member in tied):
                    tied.sort(
                        key=lambda member: (
                            -float(member.quality_score or 0),
                            member.display_name,
                            str(member.employee_id),
                        )
                    )
                else:
                    quality_skipped = quality_skipped or len(tied) > 1
                    tied.sort(key=lambda member: (member.display_name, str(member.employee_id)))
                responsible = tied[0]
                break
            assert responsible is not None
            team_samples = brigade_scores[brigade_id]
            team_quality = (
                round(sum(team_samples) / len(team_samples), 2)
                if len(team_samples) >= _BRIGADE_QUALITY_MINIMUM
                else None
            )
            reasons = [
                (
                    f"Специалистов по «{context.specialty}»: {len(matching)}."
                    if required_specialty
                    else "Специальность не подтверждена: бригада не отфильтрована по профилю."
                ),
                "Текущая нагрузка команды показана без деталей чужих нарядов.",
            ]
            if team_quality is None:
                reasons.append(
                    f"Оценённых закрытых бригадных работ: {len(team_samples)}; "
                    f"для качества нужно не менее {_BRIGADE_QUALITY_MINIMUM}."
                )
            else:
                reasons.append(
                    f"Средняя итоговая оценка бригады: {team_quality:.2f}/5 "
                    f"по {len(team_samples)} закрытым работам за {_BRIGADE_HISTORY_DAYS} дней."
                )
            responsible_reasons = [
                (
                    f"Профиль «{responsible.specialty}» соответствует контексту."
                    if required_specialty and responsible in matching
                    else (
                        f"В составе нет специалиста по «{context.specialty}»; "  # noqa: RUF001
                        "ответственный предложен только для ручного выбора."
                        if required_specialty
                        else (
                            "Контекст специальности не подтверждён; "
                            "профиль не использован как ограничение."
                        )
                    )
                ),
                "Выбран по текущей нагрузке, затем по разряду; разряд не является допуском.",
            ]
            if responsible.quality_score is None:
                responsible_reasons.append(
                    "Качество не меняло порядок: оценённых работ "
                    f"{responsible.quality_sample_count}, "
                    f"нужно не менее {_BRIGADE_QUALITY_MINIMUM}."
                )
            else:
                responsible_reasons.append(
                    f"Средняя итоговая оценка: {responsible.quality_score:.2f}/5 по "
                    f"{responsible.quality_sample_count} работам."
                )
            if quality_skipped:
                responsible_reasons.append(
                    "При равных условиях качество не сравнивалось без полной выборки."
                )
            item = BrigadeOptionItem(
                brigade=BrigadeAssignmentView(
                    id=brigades[brigade_id].id,
                    code=brigades[brigade_id].code,
                    name=brigades[brigade_id].name,
                ),
                participant_ids=[member.employee_id for member in members],
                participants=members,
                excluded_count=int(all_members.get(brigade_id, len(members))) - len(members),
                suggested_responsible_id=responsible.employee_id,
                specialty_match=specialty_match,
                matching_specialists=len(matching),
                quality_score=team_quality,
                quality_sample_count=len(team_samples),
                reasons=reasons,
                responsible_reasons=responsible_reasons,
            )
            items.append(item)
            size = len(members)
            option_keys[brigade_id] = (
                0 if specialty_match else 1,
                sum(member.running_count for member in members) / size,
                sum(member.paused_count for member in members) / size,
                sum(member.queue_length for member in members) / size,
                -responsible.grade,
            )

        ordered_items: list[BrigadeOptionItem] = []
        for key in sorted(set(option_keys.values())):
            tied_options = [item for item in items if option_keys[item.brigade.id] == key]
            if len(tied_options) > 1 and all(
                item.quality_score is not None for item in tied_options
            ):
                tied_options.sort(
                    key=lambda item: (
                        -float(item.quality_score or 0),
                        item.brigade.code,
                        str(item.brigade.id),
                    )
                )
            else:
                tied_options.sort(key=lambda item: (item.brigade.code, str(item.brigade.id)))
            for item in tied_options:
                item.reasons.append("Порядок стабилен при одинаковых доступных данных.")
            ordered_items.extend(tied_options)
        items = ordered_items
        if required_specialty and items and items[0].specialty_match:
            items[0].recommended = True
        elif required_specialty:
            notes.append("Нет бригад с подтверждённым профильным специалистом на смене.")  # noqa: RUF001
        return BrigadeOptionsView(items=items, context=context, notes=notes)


async def order_detail(database: Database, principal: Principal, order_id: UUID) -> OrderDetail:
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        order = await get_order(session, order_id, principal)
        assignment = (await _assignment_views(session, [order]))[order.id]
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
            **order_view(
                order,
                datetime.now(UTC),
                brigade=assignment[0],
                participants=assignment[1],
            ).model_dump(),
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
        person_ids = [person.id for person in people]
        job_rows = (
            await session.execute(
                select(WorkOrder, WorkOrderParticipant.employee_id)
                .outerjoin(
                    WorkOrderParticipant,
                    WorkOrderParticipant.work_order_id == WorkOrder.id,
                )
                .where(
                    WorkOrder.status.in_(
                        ["issued", "accepted", "queued", "in_progress", "paused", "rework"]
                    ),
                    or_(
                        WorkOrder.executor_id.in_(person_ids),
                        WorkOrderParticipant.employee_id.in_(person_ids),
                    ),
                )
            )
        ).all()
        jobs_by_person: dict[UUID, dict[UUID, WorkOrder]] = {person.id: {} for person in people}
        for job, participant_id in job_rows:
            for employee_id in {job.executor_id, participant_id} & set(person_ids):
                jobs_by_person[employee_id][job.id] = job
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
            own = list(jobs_by_person[person.id].values())
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
