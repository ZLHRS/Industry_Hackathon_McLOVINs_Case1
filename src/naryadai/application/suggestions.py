"""Read-only, explainable work-order recommendations for masters."""

# ruff: noqa: RUF001

from __future__ import annotations

import re
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select, text

from naryadai.analytics.data import Snapshot
from naryadai.analytics.history import group_events
from naryadai.analytics.ratings import final_submission_actor, latest_score
from naryadai.application.common import OperationError, ensure_role
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import WorkOrderStatus
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    AIReview,
    Area,
    Employee,
    EmployeeArea,
    Equipment,
    FaultCode,
    TimeNorm,
    WorkOrder,
    WorkOrderEvent,
)

_TOKEN = re.compile(r"[0-9a-zа-яё]+", re.IGNORECASE)
_ACTIVE_WORK = (
    WorkOrderStatus.ISSUED,
    WorkOrderStatus.ACCEPTED,
    WorkOrderStatus.QUEUED,
    WorkOrderStatus.IN_PROGRESS,
    WorkOrderStatus.PAUSED,
    WorkOrderStatus.REWORK,
)
_HISTORY_DAYS = 180
_QUALITY_MINIMUM = 3
_MAX_FAULTS = 500
_MAX_HISTORY = 1_000
_MAX_CANDIDATES = 500


class SuggestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    area_id: UUID
    equipment_id: UUID
    description: str = Field(max_length=10_000)
    fault_code_id: UUID | None = None

    @field_validator("description")
    @classmethod
    def require_plain_text(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("description_must_not_contain_null")
        return value


class FaultSuggestion(BaseModel):
    fault_code_id: UUID
    code: str
    name: str
    specialty: str
    reasons: list[str] = Field(default_factory=list)
    norm_minutes: int | None = None


class ExecutorSuggestion(BaseModel):
    employee_id: UUID
    display_name: str
    specialty: str
    grade: int
    is_on_shift: bool
    availability: Literal["free", "busy", "queued", "off_shift"]
    queue_length: int
    paused_count: int
    quality_score: float | None = None
    quality_sample_count: int
    reasons: list[str] = Field(default_factory=list)


class SuggestionsView(BaseModel):
    faults: list[FaultSuggestion] = Field(default_factory=list)
    selected_norm_minutes: int | None = None
    required_specialty: str | None = None
    executors: list[ExecutorSuggestion] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


def _stem(word: str) -> str:
    """Small deterministic Russian inflection normalizer, not a language model."""

    normalized = word.lower().replace("ё", "е")
    for suffix in (
        "иями",
        "ями",
        "ами",
        "ого",
        "ему",
        "ыми",
        "ими",
        "иях",
        "иях",
        "ость",
        "ение",
        "ания",
        "ения",
        "ация",
        "ция",
        "ать",
        "ять",
        "ется",
        "ются",
        "ется",
        "ала",
        "ило",
        "или",
        "ов",
        "ев",
        "ам",
        "ям",
        "ах",
        "ях",
        "ом",
        "ем",
        "ой",
        "ий",
        "ый",
        "ая",
        "ое",
        "ые",
        "ы",
        "и",
        "а",
        "я",
        "е",
        "о",
        "у",
        "ю",
    ):
        if len(normalized) - len(suffix) >= 4 and normalized.endswith(suffix):
            return normalized[: -len(suffix)]
    return normalized


def _words(value: str) -> dict[str, str]:
    """Map normalized stems to a stable representative for explanatory copy."""

    result: dict[str, str] = {}
    for word in _TOKEN.findall(value.lower()):
        stem = _stem(word)
        if len(stem) >= 3:
            result.setdefault(stem, word)
    return result


_SYNONYMS: dict[str, frozenset[str]] = {
    "утечка": frozenset(
        {_stem(word) for word in ("утечка", "течь", "протечка", "подтекание", "подтекает", "потек")}
    ),
    "вибрация": frozenset({_stem(word) for word in ("вибрация", "вибрирует", "биение", "тряска")}),
    "перегрев": frozenset(
        {_stem(word) for word in ("перегрев", "греется", "перегрелся", "перегревается")}
    ),
    "давление": frozenset({_stem(word) for word in ("давление", "напор", "разгерметизация")}),
    "подшипник": frozenset({_stem(word) for word in ("подшипник", "подшипника", "подшипников")}),
    "двигатель": frozenset({_stem(word) for word in ("двигатель", "электродвигатель", "мотор")}),
}
_GENERIC_ACTION_WORDS = frozenset(
    _stem(word)
    for word in ("проверка", "ремонт", "работа", "замена", "неисправность", "оборудование", "узел")
)


def _fault_match(fault: FaultCode, description: str) -> tuple[int, list[str]]:
    """Return deterministic text evidence only; unknown descriptions have no match."""

    source = _words(description)
    if not source:
        return 0, []
    score, reasons = 0, []
    code_chars = [character for character in fault.code if character.isalnum()]
    code_pattern = r"[\W_]*".join(re.escape(character) for character in code_chars)
    if len(code_chars) >= 2 and re.search(
        rf"(?<![0-9a-zа-я]){code_pattern}(?![0-9a-zа-я])", description, re.IGNORECASE
    ):
        score += 100
        reasons.append(f"В описании указан шифр «{fault.code}».")

    target = _words(fault.name)
    direct = sorted((set(source) & set(target)) - _GENERIC_ACTION_WORDS)
    if direct:
        score += 20 * len(direct)
        shown = ", ".join(f"«{source[item]}»" for item in direct[:2])
        reasons.append(f"Совпадение с названием неисправности: {shown}.")

    for canonical, terms in _SYNONYMS.items():
        source_terms = sorted(set(source) & terms)
        target_terms = set(target) & terms
        if source_terms and target_terms and not set(source_terms) & set(target):
            score += 10
            reasons.append(f"Слово «{source[source_terms[0]]}» соответствует группе «{canonical}».")
    return score, reasons


def _availability(running: int, queue: int) -> Literal["free", "busy", "queued", "off_shift"]:
    if running:
        return "busy"
    if queue:
        return "queued"
    return "free"


async def work_order_suggestions(
    database: Database, principal: Principal, body: SuggestionRequest
) -> SuggestionsView:
    """Return bounded evidence for assignment planning without changing state."""

    ensure_role(principal, "master")
    if body.area_id not in principal.area_ids:
        raise OperationError(404, "area_not_found")
    now = datetime.now(UTC)
    history_after = now - timedelta(days=_HISTORY_DAYS)
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        area = await session.get(Area, body.area_id)
        if area is None:
            raise OperationError(404, "area_not_found")
        if not area.is_active:
            raise OperationError(409, "area_inactive")
        equipment = await session.scalar(
            select(Equipment).where(
                Equipment.id == body.equipment_id, Equipment.area_id == body.area_id
            )
        )
        if equipment is None:
            raise OperationError(404, "equipment_not_found")
        if not equipment.is_active:
            raise OperationError(409, "equipment_inactive")

        selected: FaultCode | None = None
        if body.fault_code_id is not None:
            selected = await session.get(FaultCode, body.fault_code_id)
            if selected is None:
                raise OperationError(404, "fault_code_not_found")
            matched_faults = [(selected, ["Шифр неисправности выбран мастером."])]
        else:
            fault_rows = list(
                await session.scalars(
                    select(FaultCode).order_by(FaultCode.code, FaultCode.id).limit(_MAX_FAULTS)
                )
            )
            matched_faults = []
            for fault in fault_rows:
                score, reasons = _fault_match(fault, body.description)
                if score:
                    matched_faults.append((fault, reasons))
            matched_faults.sort(
                key=lambda item: (
                    -_fault_match(item[0], body.description)[0],
                    item[0].code,
                    str(item[0].id),
                )
            )
            matched_faults = matched_faults[:3]

        norm_ids = [fault.id for fault, _ in matched_faults]
        norms = {
            row.fault_code_id: row.minutes
            for row in await session.scalars(
                select(TimeNorm).where(
                    TimeNorm.fault_code_id.in_(norm_ids),
                    TimeNorm.equipment_type == equipment.equipment_type,
                )
            )
        }
        faults = [
            FaultSuggestion(
                fault_code_id=fault.id,
                code=fault.code,
                name=fault.name,
                specialty=fault.specialty,
                reasons=reasons,
                norm_minutes=norms.get(fault.id),
            )
            for fault, reasons in matched_faults
        ]

        candidate_query = (
            select(Employee)
            .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
            .where(
                Employee.role == "executor",
                Employee.is_active.is_(True),
                Employee.is_on_shift.is_(True),
                EmployeeArea.area_id == body.area_id,
            )
            .distinct()
            .order_by(Employee.display_name, Employee.id)
            .limit(_MAX_CANDIDATES + 1)
        )
        if selected is not None:
            candidate_query = candidate_query.where(Employee.specialty == selected.specialty)
        candidates = list(await session.scalars(candidate_query))
        candidate_truncated = len(candidates) > _MAX_CANDIDATES
        candidates = candidates[:_MAX_CANDIDATES]

        candidate_ids = [person.id for person in candidates]
        load: dict[UUID, tuple[int, int, int]] = {}
        if candidate_ids:
            workload_rows = await session.execute(
                select(
                    WorkOrder.executor_id,
                    func.count().filter(WorkOrder.status == WorkOrderStatus.IN_PROGRESS),
                    func.count().filter(WorkOrder.status != WorkOrderStatus.IN_PROGRESS),
                    func.count().filter(WorkOrder.status == WorkOrderStatus.PAUSED),
                )
                .where(WorkOrder.executor_id.in_(candidate_ids), WorkOrder.status.in_(_ACTIVE_WORK))
                .group_by(WorkOrder.executor_id)
            )
            load = {
                employee_id: (int(running), int(queue), int(paused))
                for employee_id, running, queue, paused in workload_rows
            }

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
                .limit(_MAX_HISTORY + 1)
            )
        )
        history_truncated = len(history_rows) > _MAX_HISTORY
        history_orders = history_rows[:_MAX_HISTORY]
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
                    .order_by(AIReview.work_order_id, AIReview.order_version, AIReview.created_at)
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
        scored: dict[UUID, list[int]] = defaultdict(list)
        for order in history_orders:
            actor = final_submission_actor(order, history)
            history_score = latest_score(order, history)
            if actor in candidate_ids and history_score is not None:
                scored[actor].append(history_score)

    notes: list[str] = []
    if selected is None:
        if not faults:
            notes.append("По описанию не найден подходящий шифр: выберите его вручную при выдаче.")
        else:
            notes.append(
                "Подсказки по шифру не меняют специальность исполнителя без выбора мастера."
            )
    elif selected.id not in norms:
        notes.append("Для выбранного шифра и типа оборудования норматив не задан.")
    if selected is not None and not candidates:
        notes.append("Нет исполнителей на смене с требуемой специальностью на этом участке.")
    if history_truncated:
        notes.append(
            f"Для оценки учтены последние {_MAX_HISTORY} закрытых работ за {_HISTORY_DAYS} дней."
        )
    if candidate_truncated:
        notes.append(f"Для подбора рассмотрены первые {_MAX_CANDIDATES} исполнителей по имени.")

    executors: list[tuple[ExecutorSuggestion, tuple[int, int]]] = []
    for person in candidates:
        running, queue_length, paused_count = load.get(person.id, (0, 0, 0))
        availability = _availability(running, queue_length)
        samples = scored.get(person.id, [])
        sample_count = len(samples)
        quality = (
            round(sum(samples) / sample_count, 2) if sample_count >= _QUALITY_MINIMUM else None
        )
        reasons = []
        if availability == "free":
            reasons.append("Нет активных нарядов.")
        elif availability == "busy":
            reasons.append("Есть наряд в работе; детали других участков не раскрываются.")
        else:
            reasons.append(f"В очереди или на паузе: {queue_length}.")
        if selected is not None:
            reasons.append(f"Специальность соответствует шифру: «{selected.specialty}».")
        else:
            reasons.append("Шифр не подтверждён: подбор не ограничен специальностью.")
        if quality is None:
            reasons.append(
                f"Оценённых закрытых работ на типе «{equipment.equipment_type}»: {sample_count}; "
                f"для сортировки по качеству нужно не менее {_QUALITY_MINIMUM}."
            )
        else:
            reasons.append(
                f"Средняя итоговая оценка: {quality:.2f}/5 по {sample_count} закрытым работам "
                f"на типе «{equipment.equipment_type}» за {_HISTORY_DAYS} дней."
            )
        view = ExecutorSuggestion(
            employee_id=person.id,
            display_name=person.display_name,
            specialty=person.specialty,
            grade=person.grade,
            is_on_shift=person.is_on_shift,
            availability=availability,
            queue_length=queue_length,
            paused_count=paused_count,
            quality_score=quality,
            quality_sample_count=sample_count,
            reasons=reasons,
        )
        availability_rank = {"free": 0, "queued": 1, "busy": 2, "off_shift": 3}[availability]
        executors.append((view, (availability_rank, queue_length)))

    ranked: list[ExecutorSuggestion] = []
    quality_comparison_skipped = False
    for load_key in sorted({key for _, key in executors}):
        tied = [view for view, key in executors if key == load_key]
        if all(view.quality_score is not None for view in tied):
            tied.sort(
                key=lambda view: (
                    -float(view.quality_score or 0),
                    view.display_name,
                    str(view.employee_id),
                )
            )
        else:
            quality_comparison_skipped = quality_comparison_skipped or len(tied) > 1
            tied.sort(key=lambda view: (view.display_name, str(view.employee_id)))
        ranked.extend(tied)
    if quality_comparison_skipped:
        notes.append(
            "При одинаковой нагрузке качество не меняло порядок: "
            "не у всех кандидатов достаточно оценённых работ."
        )

    return SuggestionsView(
        faults=faults,
        selected_norm_minutes=None if selected is None else norms.get(selected.id),
        required_specialty=None if selected is None else selected.specialty,
        executors=ranked[:3],
        notes=notes,
    )
