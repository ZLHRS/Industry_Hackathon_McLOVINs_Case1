"""Bounded, explainable memory of master-accepted repairs for issuance."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, text

from naryadai.application.common import OperationError, ensure_role
from naryadai.application.suggestions import _SYNONYMS, SuggestionRequest, _words
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import ActorRole, WorkOrderStatus
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    Area,
    Equipment,
    FaultCode,
    Material,
    MaterialUsage,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

_HISTORY_DAYS = 365
_FOLLOWUP_DAYS = 7
_MAX_CANDIDATES = 500
_MAX_EVENT_ROWS = 1_000
_MAX_MATERIAL_ROWS = 10_000
_GENERIC_TERMS = frozenset(
    _words(
        "демо конвейер линия насос проверка проверить ремонт работа выполнить "
        "устранить требуется замена неисправность оборудование узел агрегат"
    )
)


class RepairMaterial(BaseModel):
    model_config = ConfigDict(frozen=True)

    material_id: UUID
    code: str
    name: str
    unit: str
    quantity: str


class RepairMatch(BaseModel):
    model_config = ConfigDict(frozen=True)

    reason_codes: list[
        Literal["same_equipment", "compatible_equipment_type", "same_fault_code", "matching_text"]
    ] = Field(default_factory=list)
    matched_terms: list[str] = Field(default_factory=list)


class RepeatFollowup(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: Literal["observed_repeat", "none_recorded", "observing", "unknown"]
    window_days: int = _FOLLOWUP_DAYS
    observed_days: float = Field(ge=0, le=_FOLLOWUP_DAYS)
    observed_until: datetime
    repeat_count: int | None = Field(default=None, ge=0)


class SimilarRepair(BaseModel):
    model_config = ConfigDict(frozen=True)

    order_id: UUID
    number: str
    area_id: UUID
    equipment_id: UUID
    equipment_name: str
    equipment_inventory_number: str
    equipment_type: str
    closed_at: datetime
    description: str
    work_description: str
    fault_code_id: UUID | None = None
    materials: list[RepairMaterial] = Field(default_factory=list)
    match: RepairMatch
    followup: RepeatFollowup


class SimilarRepairsView(BaseModel):
    model_config = ConfigDict(frozen=True)

    items: list[SimilarRepair] = Field(default_factory=list, max_length=3)
    history_days: int = _HISTORY_DAYS
    truncated: bool = False
    measured_at: datetime
    notes: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class _Candidate:
    order: WorkOrder
    equipment: Equipment
    submission_version: int | None
    legacy_unversioned: bool
    score: int
    reason_codes: tuple[str, ...]
    matched_terms: tuple[str, ...]


class _UnsafeSubmission:
    pass


@dataclass(frozen=True)
class _Submission:
    version: int | None
    legacy_unversioned: bool


def _meaningful_text_match(
    query: str, candidate: WorkOrder, equipment: Equipment
) -> tuple[str, ...]:
    """Reuse issuance stemming while excluding generic demo/action vocabulary."""

    requested = _words(query)
    historical = _words(f"{candidate.description} {candidate.work_description or ''}")
    ignored = _GENERIC_TERMS | set(
        _words(f"{equipment.name} {equipment.equipment_type} {equipment.inventory_number}")
    )
    direct = sorted((set(requested) & set(historical)) - ignored)
    matched = [requested[stem] for stem in direct]
    semantic: list[str] = []
    for canonical, terms in _SYNONYMS.items():
        if set(requested) & terms and set(historical) & terms:
            semantic.append(canonical)
            if canonical not in matched:
                matched.append(canonical)
    if not semantic and len(direct) < 2:
        return ()
    return tuple(matched[:5])


def _closed_by_master(
    order: WorkOrder, events: list[WorkOrderEvent]
) -> _Submission | _UnsafeSubmission:
    """Return the accepted submission, or a sentinel when legacy attempt data is unsafe."""

    closure = next(
        (
            event
            for event in reversed(events)
            if event.action in {"close", "override_close"}
            and event.actor_id is not None
            and event.actor_role == ActorRole.MASTER
            and event.to_status is WorkOrderStatus.CLOSED
            and event.occurred_at == order.closed_at
        ),
        None,
    )
    if closure is None:
        return _UNSAFE
    submitted = closure.details.get("submission_version")
    if isinstance(submitted, int) and not isinstance(submitted, bool) and submitted > 0:
        if order.last_submission_version is not None and submitted != order.last_submission_version:
            return _UNSAFE
        return _Submission(version=submitted, legacy_unversioned=False)
    # Legacy rows without a submission version are safe only when they never reworked.
    return (
        _Submission(version=order.last_submission_version, legacy_unversioned=True)
        if order.attempt == 1
        else _UNSAFE
    )


_UNSAFE = _UnsafeSubmission()


def _followup(candidate: _Candidate, now: datetime, repeat_count: int | None) -> RepeatFollowup:
    order = candidate.order
    assert order.closed_at is not None
    observed_until = min(order.closed_at + timedelta(days=_FOLLOWUP_DAYS), now)
    observed_days = max(0.0, (observed_until - order.closed_at).total_seconds() / 86_400)
    if order.fault_code_id is None:
        return RepeatFollowup(
            status="unknown",
            observed_days=round(observed_days, 3),
            observed_until=observed_until,
            repeat_count=None,
        )
    assert repeat_count is not None
    if repeat_count:
        status: Literal["observed_repeat", "none_recorded", "observing", "unknown"] = (
            "observed_repeat"
        )
    elif observed_days < _FOLLOWUP_DAYS:
        status = "observing"
    else:
        status = "none_recorded"
    return RepeatFollowup(
        status=status,
        observed_days=round(observed_days, 3),
        observed_until=observed_until,
        repeat_count=repeat_count,
    )


async def similar_repairs(
    database: Database, principal: Principal, body: SuggestionRequest
) -> SimilarRepairsView:
    """Return up to three relevant, master-closed repairs without changing state."""

    ensure_role(principal, "master")
    if body.area_id not in principal.area_ids:
        raise OperationError(404, "equipment_not_found")
    now = datetime.now(UTC)
    history_after = now - timedelta(days=_HISTORY_DAYS)
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        area = await session.get(Area, body.area_id)
        if area is None:
            raise OperationError(404, "equipment_not_found")
        if not area.is_active:
            raise OperationError(409, "area_inactive")
        selected_equipment = await session.scalar(
            select(Equipment).where(
                Equipment.id == body.equipment_id, Equipment.area_id == body.area_id
            )
        )
        if selected_equipment is None:
            raise OperationError(404, "equipment_not_found")
        if not selected_equipment.is_active:
            raise OperationError(409, "equipment_inactive")
        if (
            body.fault_code_id is not None
            and await session.get(FaultCode, body.fault_code_id) is None
        ):
            raise OperationError(404, "fault_code_not_found")

        rows = list(
            await session.execute(
                select(WorkOrder, Equipment)
                .join(Equipment, Equipment.id == WorkOrder.equipment_id)
                .where(
                    WorkOrder.area_id.in_(principal.area_ids),
                    WorkOrder.status == WorkOrderStatus.CLOSED,
                    WorkOrder.closed_at.is_not(None),
                    WorkOrder.closed_at >= history_after,
                    WorkOrder.closed_at <= now,
                    Equipment.equipment_type == selected_equipment.equipment_type,
                )
                .order_by(WorkOrder.closed_at.desc(), WorkOrder.id)
                .limit(_MAX_CANDIDATES + 1)
            )
        )
        truncated = len(rows) > _MAX_CANDIDATES
        rows = rows[:_MAX_CANDIDATES]
        order_ids = [order.id for order, _ in rows]
        event_rows = (
            list(
                await session.scalars(
                    select(WorkOrderEvent)
                    .where(
                        WorkOrderEvent.work_order_id.in_(order_ids),
                        WorkOrderEvent.action.in_(("close", "override_close")),
                    )
                    .order_by(WorkOrderEvent.work_order_id, WorkOrderEvent.sequence)
                    .limit(_MAX_EVENT_ROWS + 1)
                )
            )
            if order_ids
            else []
        )
        if len(event_rows) > _MAX_EVENT_ROWS:
            truncated = True
            event_rows = event_rows[:_MAX_EVENT_ROWS]
        event_map: dict[UUID, list[WorkOrderEvent]] = defaultdict(list)
        for event in event_rows:
            event_map[event.work_order_id].append(event)

        candidates: list[_Candidate] = []
        for order, equipment in rows:
            if not order.work_description:
                continue
            submission = _closed_by_master(order, event_map[order.id])
            if isinstance(submission, _UnsafeSubmission):
                continue
            same_fault = (
                body.fault_code_id is not None and order.fault_code_id == body.fault_code_id
            )
            terms = (
                ()
                if body.fault_code_id is not None
                else _meaningful_text_match(body.description, order, equipment)
            )
            if not same_fault and not terms:
                continue
            reason_codes = [
                "same_equipment"
                if order.equipment_id == selected_equipment.id
                else "compatible_equipment_type"
            ]
            if same_fault:
                reason_codes.append("same_fault_code")
            if terms:
                reason_codes.append("matching_text")
            score = (
                (100 if order.equipment_id == selected_equipment.id else 0)
                + (50 if same_fault else 0)
                + min(25, 10 * len(terms))
            )
            candidates.append(
                _Candidate(
                    order=order,
                    equipment=equipment,
                    submission_version=submission.version,
                    legacy_unversioned=submission.legacy_unversioned,
                    score=score,
                    reason_codes=tuple(reason_codes),
                    matched_terms=terms,
                )
            )
        candidates.sort(
            key=lambda item: (
                -item.score,
                -(item.order.closed_at or now).timestamp(),
                item.order.number,
            )
        )
        candidates = candidates[:3]

        material_rows = (
            list(
                await session.execute(
                    select(MaterialUsage, Material)
                    .join(Material, Material.id == MaterialUsage.material_id)
                    .where(MaterialUsage.work_order_id.in_([item.order.id for item in candidates]))
                    .order_by(MaterialUsage.work_order_id, Material.code, Material.id)
                    .limit(_MAX_MATERIAL_ROWS + 1)
                )
            )
            if candidates
            else []
        )
        if len(material_rows) > _MAX_MATERIAL_ROWS:
            truncated = True
            material_rows = material_rows[:_MAX_MATERIAL_ROWS]
        raw_materials: dict[UUID, list[tuple[MaterialUsage, Material]]] = defaultdict(list)
        for usage, material in material_rows:
            raw_materials[usage.work_order_id].append((usage, material))
        materials: dict[UUID, list[RepairMaterial]] = defaultdict(list)
        for item in candidates:
            rows_for_order = raw_materials[item.order.id]
            exact = [
                row
                for row in rows_for_order
                if row[0].submission_version == item.submission_version
            ]
            chosen = exact
            if (
                not exact
                and item.legacy_unversioned
                and all(usage.submission_version is None for usage, _ in rows_for_order)
            ):
                chosen = rows_for_order
            for usage, material in chosen:
                materials[item.order.id].append(
                    RepairMaterial(
                        material_id=material.id,
                        code=material.code,
                        name=material.name,
                        unit=material.unit,
                        quantity=str(usage.quantity),
                    )
                )

        repeat_counts: dict[UUID, int | None] = {}
        for item in candidates:
            order = item.order
            if order.fault_code_id is None:
                repeat_counts[order.id] = None
                continue
            assert order.closed_at is not None
            observed_until = min(order.closed_at + timedelta(days=_FOLLOWUP_DAYS), now)
            repeat_counts[order.id] = int(
                await session.scalar(
                    select(func.count())
                    .select_from(WorkOrder)
                    .where(
                        WorkOrder.equipment_id == order.equipment_id,
                        WorkOrder.fault_code_id == order.fault_code_id,
                        WorkOrder.work_type == WorkType.UNPLANNED,
                        WorkOrder.status != WorkOrderStatus.CANCELLED,
                        WorkOrder.issued_at > order.closed_at,
                        WorkOrder.issued_at <= observed_until,
                        WorkOrder.issued_at <= now,
                    )
                )
                or 0
            )

    notes: list[str] = []
    if truncated:
        notes.append("История ограничена: показаны результаты по доступной части выборки.")
    return SimilarRepairsView(
        items=[
            SimilarRepair(
                order_id=item.order.id,
                number=item.order.number,
                area_id=item.order.area_id,
                equipment_id=item.equipment.id,
                equipment_name=item.equipment.name,
                equipment_inventory_number=item.equipment.inventory_number,
                equipment_type=item.equipment.equipment_type,
                closed_at=item.order.closed_at,
                description=item.order.description,
                work_description=item.order.work_description,
                fault_code_id=item.order.fault_code_id,
                materials=materials[item.order.id],
                match=RepairMatch(
                    reason_codes=item.reason_codes,
                    matched_terms=item.matched_terms,
                ),
                followup=_followup(item, now, repeat_counts[item.order.id]),
            )
            for item in candidates
            if item.order.closed_at is not None and item.order.work_description is not None
        ],
        truncated=truncated,
        measured_at=now,
        notes=notes,
    )
