"""Read-only, citation-grounded answers for a master's operational questions."""

# Russian and Kazakh response templates intentionally use Cyrillic text.
# ruff: noqa: E501, RUF001

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Literal, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import case, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from naryadai.ai.contracts import OpenAIReviewConfig
from naryadai.ai.master_assistant import AssistantIntent, classify_intent
from naryadai.application.common import OperationError, ensure_role
from naryadai.application.repair_memory import _closed_by_master, _UnsafeSubmission
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import WorkOrderStatus
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    Area,
    Equipment,
    FaultCode,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

type AssistantTopic = Literal["attention", "repeated_faults", "accepted_repair_history"]
_MAX_CANDIDATES = 500
_MAX_EVENTS = 5_000
_MAX_CITATIONS = 5
_REPEAT_DAYS = 90
_HISTORY_DAYS = 365
_WORD = re.compile(r"[\w-]+", re.UNICODE)


class AssistantQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    question: str = Field(min_length=1, max_length=500)
    topic: Literal["attention", "repeated_faults", "accepted_repair_history"] | None = None
    area_id: UUID | None = None
    equipment_id: UUID | None = None
    language: Literal["ru", "kk", "en"] = "ru"

    @field_validator("question")
    @classmethod
    def clean_question(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("question_invalid")
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("question_required")
        return normalized


class AssistantScope(BaseModel):
    model_config = ConfigDict(frozen=True)

    area_id: UUID | None = None
    equipment_id: UUID | None = None


class AssistantPeriod(BaseModel):
    model_config = ConfigDict(frozen=True)

    from_: datetime | None = Field(default=None, serialization_alias="from")
    to: datetime | None = None


class AssistantCitation(BaseModel):
    model_config = ConfigDict(frozen=True)

    order_id: UUID
    number: str
    description: str
    equipment_id: UUID
    equipment_name: str
    equipment_inventory_number: str
    status: WorkOrderStatus
    issued_at: datetime
    closed_at: datetime | None = None
    evidence: str = Field(max_length=600)


class MasterAssistantAnswer(BaseModel):
    model_config = ConfigDict(frozen=True)

    answer: str = Field(max_length=2_000)
    topic: Literal["attention", "repeated_faults", "accepted_repair_history"] | None = None
    answer_source: Literal["data", "clarification"]
    interpretation_source: Literal["explicit", "rules", "model"]
    scope: AssistantScope
    period: AssistantPeriod
    matching_orders: int = Field(ge=0)
    citations: list[AssistantCitation] = Field(default_factory=list, max_length=_MAX_CITATIONS)
    no_data: bool
    truncated: bool = False
    limitations: list[str] = Field(default_factory=list)
    measured_at: datetime


IntentClassifier = Callable[[str, OpenAIReviewConfig], Awaitable[AssistantIntent | None]]


def _rules_topic(
    question: str,
) -> Literal["attention", "repeated_faults", "accepted_repair_history"] | None:
    """Fast-path only fixed chip labels; all free text is classified strictly."""

    aliases = {
        "требующие внимания наряды": "attention",
        "что требует внимания?": "attention",
        "что сейчас требует внимания?": "attention",
        "orders needing attention": "attention",
        "назар аударуды қажет ететін нарядтар": "attention",
        "повторные неисправности": "repeated_faults",
        "repeated faults": "repeated_faults",
        "қайталанатын ақаулар": "repeated_faults",
        "история принятых ремонтов": "accepted_repair_history",
        "как ремонтировали раньше?": "accepted_repair_history",
        "accepted repair history": "accepted_repair_history",
        "қабылданған жөндеу тарихы": "accepted_repair_history",
    }
    return aliases.get(question.casefold())  # type: ignore[return-value]


def _has_unsupported_filter(question: str) -> bool:
    folded = question.casefold()
    return bool(
        re.search(r"\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b", folded)
        or re.search(r"\b(?:апта|ай)\b", folded)
        or re.search(
            r"\bза\s+(?:последние\s+)?\d+\s*(?:дн(?:я|ей)?|недел\w*|месяц\w*|год\w*)",
            folded,
        )
        or re.search(
            r"\b(?:past|last)\s+\d+\s+(?:days?|weeks?|months?|years?)\b",
            folded,
        )
        or any(
            marker in folded
            for marker in (
                "вчера",
                "сегодня",
                "за неделю",
                "за месяц",
                "yesterday",
                "today",
                "last week",
                "last month",
                "кеше",
                "бүгін",
            )
        )
    )


def _localized(language: str, key: str, **values: object) -> str:
    copy = {
        "ru": {
            "clarify": "Уточните тему: требующие внимания наряды, повторные неисправности или история принятых ремонтов.",
            "equipment": "Уточните оборудование: выберите его из доступного списка или укажите инвентарный номер.",
            "scope": "Выбранное оборудование не относится к указанному участку. Уточните выбор.",
            "none_attention": "В доступной области нет нарядов, требующих внимания на момент проверки.",
            "none_repeat": "За последние {days} дней в доступной области не найдено повторных внеплановых неисправностей.",
            "none_history": "В доступной области нет подтверждённых мастером ремонтов по этому запросу.",
            "attention": "Найдено нарядов, требующих внимания: {count}.",
            "repeat": "Найдено внеплановых нарядов в повторяющихся неисправностях: {count}.",
            "history": "Найдено подтверждённых мастером ремонтов: {count}.",
            "limited": "Показана ограниченная выборка; число и цитаты относятся к проверенному пределу.",
        },
        "en": {
            "clarify": "Choose a topic: orders needing attention, repeated faults, or accepted repair history.",
            "equipment": "Choose equipment from the available list or provide its inventory number.",
            "scope": "The selected equipment does not belong to the selected area. Refine the selection.",
            "none_attention": "No orders needing attention were found in the accessible scope at the check time.",
            "none_repeat": "No repeated unplanned faults were found in the accessible scope in the last {days} days.",
            "none_history": "No master-confirmed repairs were found in the accessible scope for this request.",
            "attention": "Orders needing attention found: {count}.",
            "repeat": "Unplanned orders in repeated faults found: {count}.",
            "history": "Master-confirmed repairs found: {count}.",
            "limited": "A bounded sample is shown; the count and citations apply to the checked limit.",
        },
        "kk": {
            "clarify": "Тақырыпты нақтылаңыз: назар аударуды қажет ететін нарядтар, қайталанатын ақаулар немесе қабылданған жөндеу тарихы.",
            "equipment": "Жабдықты қолжетімді тізімнен таңдаңыз немесе мүліктік нөмірін көрсетіңіз.",
            "scope": "Таңдалған жабдық көрсетілген учаскеге жатпайды. Таңдауды нақтылаңыз.",
            "none_attention": "Тексеру сәтінде қолжетімді аумақта назар аударуды қажет ететін нарядтар табылмады.",
            "none_repeat": "Соңғы {days} күнде қолжетімді аумақта қайталанатын жоспардан тыс ақаулар табылмады.",
            "none_history": "Осы сұрау бойынша қолжетімді аумақта шебер растаған жөндеулер табылмады.",
            "attention": "Назар аударуды қажет ететін нарядтар: {count}.",
            "repeat": "Қайталанатын ақаулардағы жоспардан тыс нарядтар: {count}.",
            "history": "Шебер растаған жөндеулер: {count}.",
            "limited": "Шектеулі іріктеу көрсетілді; сан мен сілтемелер тексерілген шекке қатысты.",
        },
    }
    return copy[language][key].format(**values)


def _clarification(
    body: AssistantQuestion,
    now: datetime,
    source: Literal["explicit", "rules", "model"],
    *,
    equipment: bool = False,
    scope: AssistantScope | None = None,
) -> MasterAssistantAnswer:
    return MasterAssistantAnswer(
        answer=_localized(body.language, "equipment" if equipment else "clarify"),
        topic=None,
        answer_source="clarification",
        interpretation_source=source,
        scope=scope or AssistantScope(area_id=body.area_id, equipment_id=body.equipment_id),
        period=AssistantPeriod(to=now),
        matching_orders=0,
        citations=[],
        no_data=True,
        measured_at=now,
    )


async def master_assistant_answer(
    database: Database,
    principal: Principal,
    body: AssistantQuestion,
    config: OpenAIReviewConfig,
    *,
    classifier: IntentClassifier = classify_intent,
    now: datetime | None = None,
) -> MasterAssistantAnswer:
    """Resolve a bounded intent before one scoped, read-only fact snapshot."""

    ensure_role(principal, "master")
    moment = now or datetime.now(UTC)
    if _has_unsupported_filter(body.question):
        return _clarification(
            body,
            moment,
            "explicit" if body.topic is not None else "rules",
        )
    if body.topic is not None:
        topic = body.topic
        source: Literal["explicit", "rules", "model"] = "explicit"
        plan = None
    else:
        routed = _rules_topic(body.question)
        source = "rules"
        plan = None
        if routed is None:
            plan = await classifier(body.question, config)
            source = "model"
            if plan is None or plan.topic == "unsupported":
                return _clarification(body, moment, source)
            plan, invalid_equipment_code, invalid_search_text = _ground_plan(plan, body.question)
            if invalid_equipment_code or invalid_search_text:
                return _clarification(body, moment, source, equipment=True)
            topic = cast(AssistantTopic, plan.topic)
        else:
            topic = routed
    return await _answer_snapshot(database, principal, body, topic, source, plan, moment)


def _ground_plan(plan: AssistantIntent, question: str) -> tuple[AssistantIntent, bool, bool]:
    """Discard model fields that were not literally supplied by the user."""

    folded = question.casefold()
    equipment_code = plan.equipment_code
    invalid_equipment_code = False
    invalid_search_text = False
    if equipment_code is not None:
        code = re.escape(equipment_code.casefold())
        if re.search(rf"(?<![\w-]){code}(?![\w-])", folded) is None:
            equipment_code = None
            invalid_equipment_code = True
    search_text = plan.search_text
    if search_text is not None:
        question_words = set(_WORD.findall(folded))
        search_words = set(_WORD.findall(search_text.casefold()))
        if not search_words or not search_words <= question_words:
            search_text = None
            invalid_search_text = True
    return (
        plan.model_copy(update={"equipment_code": equipment_code, "search_text": search_text}),
        invalid_equipment_code,
        invalid_search_text,
    )


async def _answer_snapshot(
    database: Database,
    principal: Principal,
    body: AssistantQuestion,
    topic: Literal["attention", "repeated_faults", "accepted_repair_history"],
    source: Literal["explicit", "rules", "model"],
    plan: AssistantIntent | None,
    now: datetime,
) -> MasterAssistantAnswer:
    async with database.sessions.begin() as session:
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"))
        area: Area | None = None
        if body.area_id is not None:
            area = await session.scalar(
                select(Area).where(Area.id == body.area_id, Area.id.in_(principal.area_ids))
            )
            if area is None:
                raise OperationError(404, "assistant_scope_not_found")
        equipment: Equipment | None = None
        if body.equipment_id is not None:
            equipment = await session.scalar(
                select(Equipment).where(
                    Equipment.id == body.equipment_id,
                    Equipment.area_id.in_(principal.area_ids),
                )
            )
            if equipment is None:
                raise OperationError(404, "assistant_scope_not_found")
        elif plan is not None and plan.equipment_code is not None:
            equipment = await session.scalar(
                select(Equipment).where(
                    Equipment.inventory_number == plan.equipment_code,
                    Equipment.area_id.in_(principal.area_ids),
                )
            )
            if equipment is None:
                return _clarification(body, now, source, equipment=True)
        if (
            equipment is not None
            and plan is not None
            and plan.equipment_code is not None
            and equipment.inventory_number != plan.equipment_code
        ):
            return _clarification(body, now, source, equipment=True)
        if area is not None and equipment is not None and equipment.area_id != area.id:
            return _clarification(
                body,
                now,
                source,
                scope=AssistantScope(area_id=area.id, equipment_id=equipment.id),
            ).model_copy(update={"answer": _localized(body.language, "scope")})
        scope = AssistantScope(
            area_id=area.id if area else equipment.area_id if equipment else None,
            equipment_id=equipment.id if equipment else None,
        )
        if topic == "attention":
            return await _attention(session, principal, body, source, scope, area, equipment, now)
        if topic == "repeated_faults":
            return await _repeated(session, principal, body, source, scope, area, equipment, now)
        search = plan.search_text if plan is not None else None
        if equipment is None and not _meaningful(search):
            return _clarification(body, now, source, equipment=True, scope=scope)
        return await _history(session, principal, body, source, scope, area, equipment, search, now)


def _base_scope(
    principal: Principal, area: Area | None, equipment: Equipment | None
) -> list[ColumnElement[bool]]:
    predicates: list[ColumnElement[bool]] = [WorkOrder.area_id.in_(principal.area_ids)]
    if area is not None:
        predicates.append(WorkOrder.area_id == area.id)
    if equipment is not None:
        predicates.append(WorkOrder.equipment_id == equipment.id)
    return predicates


def _citation(order: WorkOrder, equipment: Equipment, evidence: str) -> AssistantCitation:
    return AssistantCitation(
        order_id=order.id,
        number=order.number,
        description=order.description,
        equipment_id=equipment.id,
        equipment_name=equipment.name,
        equipment_inventory_number=equipment.inventory_number,
        status=order.status,
        issued_at=order.issued_at,
        closed_at=order.closed_at,
        evidence=evidence[:600],
    )


def _timestamp(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%d.%m.%Y %H:%M UTC")


def _history_evidence(language: str, order: WorkOrder) -> str:
    assert order.closed_at is not None
    labels = {
        "ru": "Принято мастером {closed}; результат: {result}",
        "kk": "Шебер қабылдады: {closed}; нәтиже: {result}",
        "en": "Accepted by a master on {closed}; result: {result}",
    }
    return labels[language].format(
        closed=_timestamp(order.closed_at),
        result=(order.work_description or order.description)[:420],
    )


def _repeat_evidence(language: str, count: int, fault: FaultCode | None) -> str:
    labels = {
        "ru": "Повторение: {count} внеплановых нарядов; шифр неисправности {code}.",
        "kk": "Қайталану: {count} жоспардан тыс наряд; ақау коды {code}.",
        "en": "Repeated fault: {count} unplanned orders; fault code {code}.",
    }
    return labels[language].format(count=count, code=fault.code if fault else "—")


def _attention_evidence(language: str, order: WorkOrder) -> str:
    labels = {
        "ru": "Срок выполнения: {deadline}.",
        "kk": "Орындау мерзімі: {deadline}.",
        "en": "Deadline: {deadline}.",
    }
    return labels[language].format(deadline=_timestamp(order.deadline))


async def _attention(
    session: AsyncSession,
    principal: Principal,
    body: AssistantQuestion,
    source: Literal["explicit", "rules", "model"],
    scope: AssistantScope,
    area: Area | None,
    equipment: Equipment | None,
    now: datetime,
) -> MasterAssistantAnswer:
    predicates = _base_scope(principal, area, equipment)
    overdue = (WorkOrder.deadline < now) & WorkOrder.status.not_in(
        [
            WorkOrderStatus.REJECTED,
            WorkOrderStatus.COMPLETED,
            WorkOrderStatus.AI_REVIEW,
            WorkOrderStatus.CLOSED,
            WorkOrderStatus.CANCELLED,
        ]
    )
    decision = WorkOrder.status.in_(
        [WorkOrderStatus.REJECTED, WorkOrderStatus.COMPLETED, WorkOrderStatus.AI_REVIEW]
    )
    attention = (
        (WorkOrder.issued_at <= now)
        & WorkOrder.status.not_in([WorkOrderStatus.CLOSED, WorkOrderStatus.CANCELLED])
        & (WorkOrder.priority.in_(["emergency", "high"]) | overdue | decision)
    )
    total = (
        await session.scalar(
            select(func.count()).select_from(WorkOrder).where(*predicates, attention)
        )
        or 0
    )
    priority_order = case(
        (WorkOrder.priority == "emergency", 0), (WorkOrder.priority == "high", 1), else_=2
    )
    rows = list(
        await session.execute(
            select(WorkOrder, Equipment)
            .join(Equipment)
            .where(*predicates, attention)
            .order_by(priority_order, WorkOrder.deadline, WorkOrder.id)
            .limit(_MAX_CITATIONS)
        )
    )
    citations = [
        _citation(
            order,
            machine,
            _attention_evidence(body.language, order),
        )
        for order, machine in rows
    ]
    answer = _localized(body.language, "attention" if total else "none_attention", count=total)
    return MasterAssistantAnswer(
        answer=answer,
        topic="attention",
        answer_source="data",
        interpretation_source=source,
        scope=scope,
        period=AssistantPeriod(to=now),
        matching_orders=total,
        citations=citations,
        no_data=not bool(total),
        measured_at=now,
    )


async def _repeated(
    session: AsyncSession,
    principal: Principal,
    body: AssistantQuestion,
    source: Literal["explicit", "rules", "model"],
    scope: AssistantScope,
    area: Area | None,
    equipment: Equipment | None,
    now: datetime,
) -> MasterAssistantAnswer:
    start = now - timedelta(days=_REPEAT_DAYS)
    predicates = [
        *_base_scope(principal, area, equipment),
        WorkOrder.work_type == WorkType.UNPLANNED,
        WorkOrder.status != WorkOrderStatus.CANCELLED,
        WorkOrder.fault_code_id.is_not(None),
        WorkOrder.issued_at >= start,
        WorkOrder.issued_at <= now,
    ]
    rows = list(
        await session.execute(
            select(WorkOrder, Equipment, FaultCode)
            .join(Equipment)
            .outerjoin(FaultCode)
            .where(*predicates)
            .order_by(WorkOrder.issued_at.desc(), WorkOrder.id)
            .limit(_MAX_CANDIDATES + 1)
        )
    )
    truncated = len(rows) > _MAX_CANDIDATES
    rows = rows[:_MAX_CANDIDATES]
    grouped: dict[tuple[UUID, UUID], list[tuple[WorkOrder, Equipment, FaultCode | None]]] = (
        defaultdict(list)
    )
    for order, machine, fault in rows:
        fault_id = order.fault_code_id
        if fault_id is None:
            continue
        grouped[(order.equipment_id, fault_id)].append((order, machine, fault))
    repeated = [items for items in grouped.values() if len(items) >= 2]
    ordered = sorted(
        (item for items in repeated for item in items),
        key=lambda item: (item[0].issued_at, item[0].id),
        reverse=True,
    )
    citations: list[AssistantCitation] = []
    for order, machine, fault in ordered[:_MAX_CITATIONS]:
        fault_id = order.fault_code_id
        if fault_id is None:
            continue
        citations.append(
            _citation(
                order,
                machine,
                _repeat_evidence(
                    body.language, len(grouped[(order.equipment_id, fault_id)]), fault
                ),
            )
        )
    count = sum(len(items) for items in repeated)
    limitations = [_localized(body.language, "limited")] if truncated else []
    return MasterAssistantAnswer(
        answer=_localized(
            body.language, "repeat" if count else "none_repeat", count=count, days=_REPEAT_DAYS
        ),
        topic="repeated_faults",
        answer_source="data",
        interpretation_source=source,
        scope=scope,
        period=AssistantPeriod(from_=start, to=now),
        matching_orders=count,
        citations=citations,
        no_data=not bool(count),
        truncated=truncated,
        limitations=limitations,
        measured_at=now,
    )


def _meaningful(value: str | None) -> bool:
    return value is not None and len(value.split()) >= 2 and len(value) >= 6


async def _history(
    session: AsyncSession,
    principal: Principal,
    body: AssistantQuestion,
    source: Literal["explicit", "rules", "model"],
    scope: AssistantScope,
    area: Area | None,
    equipment: Equipment | None,
    search: str | None,
    now: datetime,
) -> MasterAssistantAnswer:
    start = now - timedelta(days=_HISTORY_DAYS)
    predicates = [
        *_base_scope(principal, area, equipment),
        WorkOrder.status == WorkOrderStatus.CLOSED,
        WorkOrder.closed_at.is_not(None),
        WorkOrder.closed_at >= start,
        WorkOrder.closed_at <= now,
    ]
    if search is not None:
        predicates.append(
            or_(
                WorkOrder.description.icontains(search, autoescape=True),
                WorkOrder.work_description.icontains(search, autoescape=True),
            )
        )
    rows = list(
        await session.execute(
            select(WorkOrder, Equipment)
            .join(Equipment)
            .where(*predicates)
            .order_by(WorkOrder.closed_at.desc(), WorkOrder.id)
            .limit(_MAX_CANDIDATES + 1)
        )
    )
    truncated = len(rows) > _MAX_CANDIDATES
    rows = rows[:_MAX_CANDIDATES]
    ids = [order.id for order, _ in rows]
    event_rows = (
        list(
            await session.scalars(
                select(WorkOrderEvent)
                .where(WorkOrderEvent.work_order_id.in_(ids))
                .order_by(
                    WorkOrderEvent.work_order_id,
                    WorkOrderEvent.occurred_at,
                    WorkOrderEvent.sequence,
                )
                .limit(_MAX_EVENTS + 1)
            )
        )
        if ids
        else []
    )
    if len(event_rows) > _MAX_EVENTS:
        truncated = True
        event_rows = event_rows[:_MAX_EVENTS]
    by_order: dict[UUID, list[WorkOrderEvent]] = defaultdict(list)
    for event in event_rows:
        by_order[event.work_order_id].append(event)
    accepted = [
        (order, machine)
        for order, machine in rows
        if not isinstance(_closed_by_master(order, by_order[order.id]), _UnsafeSubmission)
    ]
    citations = [
        _citation(
            order,
            machine,
            _history_evidence(body.language, order),
        )
        for order, machine in accepted[:_MAX_CITATIONS]
    ]
    count = len(accepted)
    limitations = [_localized(body.language, "limited")] if truncated else []
    return MasterAssistantAnswer(
        answer=_localized(body.language, "history" if count else "none_history", count=count),
        topic="accepted_repair_history",
        answer_source="data",
        interpretation_source=source,
        scope=scope,
        period=AssistantPeriod(from_=start, to=now),
        matching_orders=count,
        citations=citations,
        no_data=not bool(count),
        truncated=truncated,
        limitations=limitations,
        measured_at=now,
    )
