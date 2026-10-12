"""Read-only, scoped follow-up for work orders issued from prevention evidence."""

# ruff: noqa: RUF001

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select, text

from naryadai.analytics.contracts import AnalyticsQuery, PeriodView
from naryadai.analytics.periods import resolve_period
from naryadai.application.common import OperationError, ensure_role
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import ActorRole, WorkOrderStatus
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import Employee, Equipment, WorkOrder, WorkOrderEvent, WorkType

_OBSERVATION_DAYS = 7
_MAX_REPEAT_EVIDENCE = 20


class OutcomeEvidence(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    number: str


class RepeatEvidence(OutcomeEvidence):
    issued_at: datetime
    fault_code_id: UUID | None = None


class OutcomeSource(BaseModel):
    model_config = ConfigDict(frozen=True)

    family: Literal["recurring_fault", "after_ppr"]
    title: str
    recommendation: str
    formula: str
    order_ids: list[UUID] = Field(default_factory=list)
    evidence_orders: list[OutcomeEvidence] = Field(default_factory=list)
    comparison_kind: Literal["same_fault", "any_unplanned"]


class OutcomeClosure(BaseModel):
    model_config = ConfigDict(frozen=True)

    closed_at: datetime
    master_event_id: UUID


class OutcomeObservation(BaseModel):
    model_config = ConfigDict(frozen=True)

    window_days: int = _OBSERVATION_DAYS
    window_end: datetime
    observed_until: datetime
    observed_days: float = Field(ge=0, le=_OBSERVATION_DAYS)
    repeat_count: int = Field(ge=0)
    repeat_orders: list[RepeatEvidence] = Field(default_factory=list)
    repeat_evidence_truncated: bool = False


class PreventionOutcome(BaseModel):
    model_config = ConfigDict(frozen=True)

    order_id: UUID
    number: str
    issued_at: datetime
    area_id: UUID
    equipment_id: UUID
    equipment_name: str
    equipment_inventory_number: str
    status: WorkOrderStatus
    source: OutcomeSource | None = None
    closure: OutcomeClosure | None = None
    outcome: Literal[
        "pending",
        "cancelled",
        "under_observation",
        "repeat_detected",
        "window_completed_no_recorded_repeat",
        "unknown",
    ]
    observation: OutcomeObservation | None = None
    notes: list[str] = Field(default_factory=list)


class PreventionOutcomesView(BaseModel):
    model_config = ConfigDict(frozen=True)

    items: list[PreventionOutcome] = Field(default_factory=list)
    total: int = Field(ge=0)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1)
    period: PeriodView
    measured_at: datetime
    truncated: bool = False
    notes: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class _Lineage:
    family: Literal["recurring_fault", "after_ppr"]
    equipment_id: UUID
    order_ids: tuple[UUID, ...]
    title: str
    recommendation: str
    formula: str


def _scope(principal: Principal, query: AnalyticsQuery) -> tuple[UUID, ...]:
    ensure_role(principal, "master", "manager")
    areas = set(principal.area_ids)
    if query.area_ids and not set(query.area_ids) <= areas:
        raise OperationError(404, "analytics_area_not_found")
    return tuple(sorted(set(query.area_ids) or areas, key=str))


def _lineage(value: object, order: WorkOrder) -> _Lineage | None:
    if not isinstance(value, dict):
        return None
    family = value.get("family")
    if not isinstance(family, str) or family not in {"recurring_fault", "after_ppr"}:
        return None
    try:
        equipment_id = UUID(str(value["equipment_id"]))
        order_ids = tuple(UUID(str(item)) for item in value["order_ids"])
    except (KeyError, TypeError, ValueError):
        return None
    if (
        equipment_id != order.equipment_id
        or len(order_ids) < 2
        or len(order_ids) > 100
        or len(set(order_ids)) != len(order_ids)
    ):
        return None
    title = value.get("title")
    recommendation = value.get("recommendation")
    formula = value.get("formula")
    if not all(isinstance(item, str) and item for item in (title, recommendation, formula)):
        return None
    return _Lineage(
        family=cast(Literal["recurring_fault", "after_ppr"], family),
        equipment_id=equipment_id,
        order_ids=order_ids,
        title=cast(str, title),
        recommendation=cast(str, recommendation),
        formula=cast(str, formula),
    )


def _valid_issue_provenance(order: WorkOrder, event: WorkOrderEvent) -> bool:
    return (
        order.work_type == WorkType.PLANNED
        and event.action == "issue"
        and event.actor_id is not None
        and event.actor_role == ActorRole.MASTER
        and event.to_status == WorkOrderStatus.ISSUED
        and event.occurred_at == order.issued_at
    )


def _master_closure(
    order: WorkOrder, events: list[WorkOrderEvent], moment: datetime
) -> OutcomeClosure | None:
    if (
        order.status != WorkOrderStatus.CLOSED
        or order.closed_at is None
        or order.closed_at < order.issued_at
        or order.closed_at > moment
    ):
        return None
    event = next(
        (
            item
            for item in reversed(events)
            if item.action in {"close", "override_close"}
            and item.actor_id is not None
            and item.actor_role == ActorRole.MASTER
            and item.to_status == WorkOrderStatus.CLOSED
            and item.occurred_at == order.closed_at
        ),
        None,
    )
    return (
        OutcomeClosure(closed_at=order.closed_at, master_event_id=event.id)
        if event is not None
        else None
    )


async def prevention_outcomes(
    database: Database,
    principal: Principal,
    query: AnalyticsQuery,
    *,
    offset: int = 0,
    limit: int = 50,
    now: datetime | None = None,
) -> PreventionOutcomesView:
    """List prevention-originated orders by issue date without mutating report data."""

    areas = _scope(principal, query)
    moment = now or datetime.now(UTC)
    period = resolve_period(query)
    end = min(period.to, moment)
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        filters = [
            WorkOrder.area_id.in_(areas),
            WorkOrder.issued_at >= period.from_,
            WorkOrder.issued_at < end,
            WorkOrderEvent.action == "issue",
            WorkOrderEvent.details["prevention_source"].is_not(None),
        ]
        if query.equipment_ids:
            filters.append(WorkOrder.equipment_id.in_(query.equipment_ids))
        if query.executor_ids:
            filters.append(WorkOrder.executor_id.in_(query.executor_ids))
        if query.brigade_ids:
            filters.append(
                or_(
                    WorkOrder.brigade_id.in_(query.brigade_ids),
                    WorkOrder.brigade_id.is_(None) & Employee.brigade_id.in_(query.brigade_ids),
                )
            )

        statement = (
            select(WorkOrder, WorkOrderEvent, Equipment).join(WorkOrderEvent).join(Equipment)
        )
        count_statement = (
            select(func.count()).select_from(WorkOrder).join(WorkOrderEvent).join(Equipment)
        )
        if query.brigade_ids:
            statement = statement.outerjoin(Employee, Employee.id == WorkOrder.executor_id)
            count_statement = count_statement.outerjoin(
                Employee, Employee.id == WorkOrder.executor_id
            )
        total = int(await session.scalar(count_statement.where(*filters)) or 0)
        rows = list(
            await session.execute(
                statement.where(*filters)
                .order_by(WorkOrder.issued_at.desc(), WorkOrder.id)
                .offset(offset)
                .limit(limit)
            )
        )
        orders = [order for order, _, _ in rows]
        order_ids = [order.id for order in orders]
        closure_rows = (
            list(
                await session.scalars(
                    select(WorkOrderEvent)
                    .where(
                        WorkOrderEvent.work_order_id.in_(order_ids),
                        WorkOrderEvent.action.in_(("close", "override_close")),
                    )
                    .order_by(WorkOrderEvent.work_order_id, WorkOrderEvent.sequence)
                )
            )
            if order_ids
            else []
        )
        closure_events: dict[UUID, list[WorkOrderEvent]] = defaultdict(list)
        for event in closure_rows:
            closure_events[event.work_order_id].append(event)

        parsed = {
            order.id: (
                _lineage(issue_event.details.get("prevention_source"), order)
                if _valid_issue_provenance(order, issue_event)
                else None
            )
            for order, issue_event, _ in rows
        }
        evidence_ids = {
            order_id for lineage in parsed.values() if lineage for order_id in lineage.order_ids
        }
        evidence_rows = (
            list(
                await session.scalars(
                    select(WorkOrder).where(
                        WorkOrder.id.in_(evidence_ids), WorkOrder.area_id.in_(areas)
                    )
                )
            )
            if evidence_ids
            else []
        )
        evidence_by_id = {item.id: item for item in evidence_rows}

        result: list[PreventionOutcome] = []
        for order, _, equipment in rows:
            lineage = parsed[order.id]
            closure = _master_closure(order, closure_events[order.id], moment)
            if lineage is None:
                malformed_state: Literal["cancelled", "unknown"] = (
                    "cancelled" if order.status == WorkOrderStatus.CANCELLED else "unknown"
                )
                result.append(
                    PreventionOutcome(
                        order_id=order.id,
                        number=order.number,
                        issued_at=order.issued_at,
                        area_id=order.area_id,
                        equipment_id=equipment.id,
                        equipment_name=equipment.name,
                        equipment_inventory_number=equipment.inventory_number,
                        status=order.status,
                        outcome=malformed_state,
                        closure=closure,
                        notes=["Недостаточно проверяемых данных об источнике профилактики."],
                    )
                )
                continue
            evidence = [evidence_by_id.get(item) for item in lineage.order_ids]
            source_orders = [item for item in evidence if item is not None]
            source_valid = (
                len(source_orders) == len(lineage.order_ids)
                and all(item.equipment_id == lineage.equipment_id for item in source_orders)
                and all(item.area_id == order.area_id for item in source_orders)
            )
            comparison_kind: Literal["same_fault", "any_unplanned"] = (
                "same_fault" if lineage.family == "recurring_fault" else "any_unplanned"
            )
            if not source_valid:
                result.append(
                    PreventionOutcome(
                        order_id=order.id,
                        number=order.number,
                        issued_at=order.issued_at,
                        area_id=order.area_id,
                        equipment_id=equipment.id,
                        equipment_name=equipment.name,
                        equipment_inventory_number=equipment.inventory_number,
                        status=order.status,
                        closure=closure,
                        outcome=(
                            "cancelled" if order.status == WorkOrderStatus.CANCELLED else "unknown"
                        ),
                        notes=["Недостаточно проверяемых исходных нарядов для сравнения."],
                    )
                )
                continue
            source = OutcomeSource(
                family=lineage.family,
                title=lineage.title,
                recommendation=lineage.recommendation,
                formula=lineage.formula,
                order_ids=list(lineage.order_ids),
                evidence_orders=[
                    OutcomeEvidence(id=item.id, number=item.number) for item in source_orders
                ],
                comparison_kind=comparison_kind,
            )
            if order.status == WorkOrderStatus.CANCELLED:
                cancelled_state: Literal[
                    "pending",
                    "cancelled",
                    "under_observation",
                    "repeat_detected",
                    "window_completed_no_recorded_repeat",
                    "unknown",
                ] = "cancelled"
                result.append(
                    _outcome_view(order, equipment, source, closure, cancelled_state, None, [])
                )
                continue
            if order.status != WorkOrderStatus.CLOSED:
                result.append(_outcome_view(order, equipment, source, None, "pending", None, []))
                continue
            if closure is None:
                result.append(
                    _outcome_view(
                        order,
                        equipment,
                        source,
                        None,
                        "unknown",
                        None,
                        ["Закрытие не подтверждено событием мастера."],
                    )
                )
                continue
            fault_id: UUID | None = None
            if lineage.family == "recurring_fault":
                fault_ids = {item.fault_code_id for item in source_orders}
                if len(fault_ids) != 1 or None in fault_ids:
                    result.append(
                        _outcome_view(
                            order,
                            equipment,
                            source,
                            closure,
                            "unknown",
                            None,
                            ["Не удалось определить исходный шифр неисправности."],
                        )
                    )
                    continue
                fault_id = next(iter(fault_ids))
            window_end = closure.closed_at + timedelta(days=_OBSERVATION_DAYS)
            observed_until = min(window_end, moment)
            repeat_filters = [
                WorkOrder.id != order.id,
                WorkOrder.equipment_id == order.equipment_id,
                WorkOrder.area_id == order.area_id,
                WorkOrder.work_type == WorkType.UNPLANNED,
                WorkOrder.status != WorkOrderStatus.CANCELLED,
                WorkOrder.issued_at > closure.closed_at,
                WorkOrder.issued_at <= observed_until,
            ]
            if fault_id is not None:
                repeat_filters.append(WorkOrder.fault_code_id == fault_id)
            repeat_count = int(
                await session.scalar(
                    select(func.count()).select_from(WorkOrder).where(*repeat_filters)
                )
                or 0
            )
            repeat_rows = list(
                await session.scalars(
                    select(WorkOrder)
                    .where(*repeat_filters)
                    .order_by(WorkOrder.issued_at, WorkOrder.id)
                    .limit(_MAX_REPEAT_EVIDENCE)
                )
            )
            observed_days = max(0.0, (observed_until - closure.closed_at).total_seconds() / 86_400)
            observation = OutcomeObservation(
                window_end=window_end,
                observed_until=observed_until,
                observed_days=round(observed_days, 3),
                repeat_count=repeat_count,
                repeat_orders=[
                    RepeatEvidence(
                        id=item.id,
                        number=item.number,
                        issued_at=item.issued_at,
                        fault_code_id=item.fault_code_id,
                    )
                    for item in repeat_rows
                ],
                repeat_evidence_truncated=repeat_count > len(repeat_rows),
            )
            computed_state: Literal[
                "under_observation", "repeat_detected", "window_completed_no_recorded_repeat"
            ] = (
                "repeat_detected"
                if repeat_count
                else "under_observation"
                if observed_days < _OBSERVATION_DAYS
                else "window_completed_no_recorded_repeat"
            )
            result.append(
                _outcome_view(
                    order,
                    equipment,
                    source,
                    closure,
                    computed_state,
                    observation,
                    (
                        ["Показаны первые 20 повторных нарядов; общее число указано отдельно."]
                        if observation.repeat_evidence_truncated
                        else []
                    ),
                )
            )

    return PreventionOutcomesView(
        items=result,
        total=total,
        offset=offset,
        limit=limit,
        period=period,
        measured_at=moment,
    )


def _outcome_view(
    order: WorkOrder,
    equipment: Equipment,
    source: OutcomeSource,
    closure: OutcomeClosure | None,
    outcome: Literal[
        "pending",
        "cancelled",
        "under_observation",
        "repeat_detected",
        "window_completed_no_recorded_repeat",
        "unknown",
    ],
    observation: OutcomeObservation | None,
    notes: list[str],
) -> PreventionOutcome:
    return PreventionOutcome(
        order_id=order.id,
        number=order.number,
        issued_at=order.issued_at,
        area_id=order.area_id,
        equipment_id=equipment.id,
        equipment_name=equipment.name,
        equipment_inventory_number=equipment.inventory_number,
        status=order.status,
        source=source,
        closure=closure,
        outcome=outcome,
        observation=observation,
        notes=notes,
    )
