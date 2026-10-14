# ruff: noqa: RUF001, E501
"""Pure, removable industrial maintenance history fixture; it performs no I/O."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from decimal import Decimal
from random import Random
from typing import Any
from uuid import UUID, uuid5
from zoneinfo import ZoneInfo

from .catalog import FAULTS, build_catalog

_NAMESPACE = UUID("9ed79fe7-25ed-5c36-a204-df9cec1fd1fb")
_SOURCE = "synthetic_industrial_fixture"
_SHIFT_ZONE = ZoneInfo("Asia/Almaty")
_CURRENT_STATUSES = (
    "issued",
    "accepted",
    "queued",
    "in_progress",
    "paused",
    "completed",
    "ai_review",
    "rework",
    "rejected",
    "issued",
    "in_progress",
    "paused",
)
_FAULT_TYPES = {code: frozenset(types) for code, _, _, types in FAULTS}


def generate_dataset(*, anchor: datetime, seed: int = 2026) -> dict[str, list[dict[str, Any]]]:
    """Build the complete deterministic catalog and industrial history fixture.

    This compatibility wrapper retains the historical identifiers used by
    ``generate_dataset``. Replacement workflows should call
    :func:`generate_order_dataset` with their existing catalog.
    """
    _require_aware(anchor)
    _require_seed(seed)

    def ident(kind: str, key: str) -> UUID:
        return uuid5(_NAMESPACE, f"industrial-v1:{seed}:{kind}:{key}")

    data = build_catalog(ident)
    data.update(_build_order_tables(anchor=anchor, seed=seed, catalog=data, ident=ident))
    return data


def generate_order_dataset(
    *,
    anchor: datetime,
    catalog: dict[str, list[dict[str, Any]]],
    seed: int = 2026,
    reserved_executor_ids: set[UUID] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Return only order tables using IDs and names from an existing catalog.

    ``reserved_executor_ids`` protects manually active workers from another
    synthetic ``in_progress`` or ``paused`` assignment. It affects only the
    current snapshot; closed history remains representative.
    """
    _require_aware(anchor)
    _require_seed(seed)
    _validate_catalog(catalog)
    anchor_key = anchor.astimezone(UTC).isoformat()

    def ident(kind: str, key: str) -> UUID:
        return uuid5(_NAMESPACE, f"industrial-v2:{seed}:{anchor_key}:{kind}:{key}")

    return _build_order_tables(
        anchor=anchor,
        seed=seed,
        catalog=catalog,
        ident=ident,
        reserved_executor_ids=reserved_executor_ids or set(),
    )


def _build_order_tables(
    *,
    anchor: datetime,
    seed: int,
    catalog: dict[str, list[dict[str, Any]]],
    ident: Any,
    reserved_executor_ids: set[UUID] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    random = Random(seed)
    anchor_utc = anchor.astimezone(UTC).replace(microsecond=0)
    local_anchor = anchor_utc.astimezone(_SHIFT_ZONE)
    equipment = catalog["equipment"]
    faults = catalog["fault_codes"]
    materials = catalog["materials"]
    employees = catalog["employees"]
    executors = [row for row in employees if row["role"] == "executor"]
    masters = [row for row in employees if row["role"] == "master"]
    work_orders: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    usages: list[dict[str, Any]] = []
    reviews: list[dict[str, Any]] = []
    availability: dict[UUID, datetime] = {}
    planned_recent: list[tuple[dict[str, Any], dict[str, Any]]] = []
    reserved = set(reserved_executor_ids or set())
    active_executor_ids = set(reserved)
    active_equipment_ids: set[UUID] = set()

    for index in range(600):
        current = index >= 588
        status = _CURRENT_STATUSES[index - 588] if current else "closed"
        machine, fault, work_type, related = _select_work(
            index=index,
            random=random,
            equipment=equipment,
            faults=faults,
            executors=executors,
            planned=planned_recent,
            current=current,
            active_executor_ids=active_executor_ids,
            active_equipment_ids=active_equipment_ids,
        )
        if work_type == "planned":
            planned_recent.append((machine, fault))
        if current:
            executor = _available_active_executor(
                index, executors, fault["specialty"], active_executor_ids
            )
            active_executor_ids.add(executor["id"])
            active_equipment_ids.add(machine["id"])
        else:
            executor = _executor(index, executors, status, fault)
        previous_executor = _prior_executor(executor, executors, fault["specialty"])
        master = masters[index % len(masters)]
        if current:
            issued, started, completed, deadline = _current_schedule(
                local_anchor, status, index - 588
            )
        else:
            candidate = _historical_candidate(index, local_anchor)
            started = _next_shift_start(
                max(
                    candidate,
                    availability.get(machine["id"], candidate),
                    availability.get(executor["id"], candidate),
                )
            )
            duration = timedelta(minutes=55 + (index * 17) % 125)
            completed = started + duration
            issued = started - timedelta(minutes=35 + index % 55)
            deadline = completed + timedelta(minutes=45 if index % 5 else -15)
            availability[machine["id"]] = completed + timedelta(minutes=15)
            availability[executor["id"]] = completed + timedelta(minutes=15)
        attempt = 2 if status == "rework" or (not current and index % 47 == 0) else 1
        submission = attempt if status in {"closed", "completed", "ai_review", "rework"} else None
        priority = _priority(index, machine, work_type, status)
        order = {
            "id": ident("work_order", str(index + 1)),
            "number": f"НР-{local_anchor.year}-{index + 1:04d}",
            "work_type": work_type,
            "description": _fault_description(fault, machine, work_type, related),
            "area_id": machine["area_id"],
            "equipment_id": machine["id"],
            "executor_id": executor["id"],
            "master_id": master["id"],
            "priority": priority,
            "status": status,
            "issued_at": issued,
            "deadline": deadline,
            "started_at": None
            if status in {"issued", "accepted", "queued", "rejected"}
            else started,
            "completed_at": completed if submission else None,
            "closed_at": completed + timedelta(minutes=18) if status == "closed" else None,
            "fault_code_id": fault["id"],
            "work_description": _work_done(fault, machine) if submission else None,
            "comment": _comment(status, attempt, priority),
            "version": 1,
            "attempt": attempt,
            "last_submission_version": None,
            "no_materials_reason": _no_materials_reason(fault, work_type, index, submission),
            "is_synthetic": True,
        }
        _assert_order_times(order, anchor_utc)
        work_orders.append(order)
        timeline = _timeline(order, executor, previous_executor, master, ident, index, related)
        events.extend(timeline)
        completion_version = _last_completion_version(timeline)
        order["last_submission_version"] = completion_version
        order["version"] = timeline[-1]["order_version"]
        if completion_version is not None:
            if status == "closed":
                review = _manual_review(ident, order, completed, completion_version, index)
                reviews.append(review)
                _link_close_event(timeline, review["id"])
            for material, quantity in _materials_for(
                fault["code"], materials, index, order["no_materials_reason"] is None
            ):
                usages.append(
                    {
                        "id": ident("usage", f"{index + 1}:{completion_version}:{material['id']}"),
                        "work_order_id": order["id"],
                        "material_id": material["id"],
                        "quantity": quantity,
                        "submission_version": completion_version,
                    }
                )
        if not current and index % 9 == 0:
            _add_downtime(events, ident, order, master, completed, index)
    return {
        "work_orders": work_orders,
        "work_order_events": events,
        "material_usages": usages,
        "ai_reviews": reviews,
    }


def _historical_candidate(index: int, local_anchor: datetime) -> datetime:
    """Distribute closed work across 100 days and retain recent shift evidence."""
    if index < 60:
        days_before = 110 - (index * 16) // 59
    elif index < 520:
        days_before = 89 - ((index - 60) * 85) // 459
    else:
        days_before = 10 - ((index - 520) * 9) // 67
    day = (local_anchor - timedelta(days=days_before)).date()
    hour_span = 8 if index >= 520 else 12
    instant = datetime.combine(
        day, time(6 + (index * 29) % hour_span, (index * 7) % 45), _SHIFT_ZONE
    )
    return instant.astimezone(UTC)


def _current_schedule(
    local_anchor: datetime, status: str, position: int
) -> tuple[datetime, datetime, datetime, datetime]:
    """Create an overnight/current-shift snapshot without future operational facts."""
    day = local_anchor.date()
    instant = local_anchor.astimezone(UTC)

    def ago(hours: int, minutes: int = 0) -> datetime:
        return instant - timedelta(hours=hours, minutes=minutes)

    def due(hour: int) -> datetime:
        return datetime.combine(day + timedelta(days=1), time(hour), _SHIFT_ZONE).astimezone(UTC)

    paused_deadline = (
        instant - timedelta(minutes=30) if position == 4 else instant + timedelta(hours=6)
    )
    schedules = {
        "issued": (ago(0, 20), ago(0, 10), ago(0), due(11)),
        "accepted": (ago(2), ago(1, 45), ago(1), due(14)),
        "queued": (ago(3), ago(2, 45), ago(2), due(9)),
        "in_progress": (ago(3, 30), ago(3), ago(0), instant + timedelta(hours=2)),
        "paused": (ago(4), ago(3, 30), ago(0), paused_deadline),
        "completed": (ago(5), ago(4), ago(1), instant + timedelta(hours=1)),
        "ai_review": (ago(6), ago(5), ago(2), instant + timedelta(hours=1)),
        "rework": (ago(7), ago(6), ago(3), instant + timedelta(hours=3)),
        "rejected": (ago(2), ago(1, 45), ago(1), instant + timedelta(hours=4)),
    }
    issued, started, completed, deadline = schedules[status]
    if position >= 9 and status in {"issued", "accepted", "queued"}:
        deadline += timedelta(hours=position - 8)
        issued -= timedelta(minutes=position * 7)
    return issued, started, completed, deadline


def _next_shift_start(value: datetime) -> datetime:
    local = value.astimezone(_SHIFT_ZONE)
    if local.hour >= 19:
        local = datetime.combine(local.date() + timedelta(days=1), time(6), _SHIFT_ZONE)
    elif local.hour < 6:
        local = datetime.combine(local.date(), time(6), _SHIFT_ZONE)
    return local.astimezone(UTC)


def _select_work(
    *,
    index: int,
    random: Random,
    equipment: list[dict[str, Any]],
    faults: list[dict[str, Any]],
    executors: list[dict[str, Any]],
    planned: list[tuple[dict[str, Any], dict[str, Any]]],
    current: bool,
    active_executor_ids: set[UUID],
    active_equipment_ids: set[UUID],
) -> tuple[dict[str, Any], dict[str, Any], str, bool]:
    repeated = not current and index % 24 == 1 and planned
    if repeated:
        machine, fault = planned[-1]
        return machine, fault, "unplanned", True
    machines = equipment
    active = current
    if active:
        machines = [row for row in equipment if row["id"] not in active_equipment_ids]
    machine = machines[index % len(machines)] if index % 19 == 0 else random.choice(machines)
    eligible = [
        fault
        for fault in faults
        if machine["equipment_type"] in _FAULT_TYPES.get(fault["code"], frozenset())
    ]
    if active:
        available = {row["specialty"] for row in executors if row["id"] not in active_executor_ids}
        eligible = [fault for fault in eligible if fault["specialty"] in available]
    if not eligible:
        raise ValueError(f"No compatible available fault code for {machine['equipment_type']}")
    if active:
        preferred = ("механик", "электрик", "гидравлик", "универсал")[(index - 588) % 4]
        preferred_faults = [fault for fault in eligible if fault["specialty"] == preferred]
        if preferred_faults:
            eligible = preferred_faults
    return machine, random.choice(eligible), "planned" if index % 4 == 0 else "unplanned", False


def _executor(
    index: int, executors: list[dict[str, Any]], status: str, fault: dict[str, Any]
) -> dict[str, Any]:
    eligible = [row for row in executors if row["specialty"] == fault["specialty"]]
    if not eligible:
        raise ValueError(f"No executor for specialty {fault['specialty']}")
    return (
        eligible[-1] if status == "rework" or index % 53 == 0 else eligible[index % len(eligible)]
    )


def _prior_executor(
    executor: dict[str, Any], executors: list[dict[str, Any]], specialty: str
) -> dict[str, Any]:
    return next(
        row for row in executors if row["specialty"] == specialty and row["id"] != executor["id"]
    )


def _available_active_executor(
    index: int, executors: list[dict[str, Any]], specialty: str, active_executor_ids: set[UUID]
) -> dict[str, Any]:
    available = [
        row
        for row in executors
        if row["specialty"] == specialty and row["id"] not in active_executor_ids
    ]
    if not available:
        raise ValueError(f"No available executor for active {specialty} work")
    return available[index % len(available)]


def _priority(index: int, machine: dict[str, Any], work_type: str, status: str) -> str:
    if work_type == "planned":
        return "planned"
    if status in {"issued", "accepted", "queued"}:
        return "normal"
    if machine.get("criticality", 1) >= 4 and index % 13 == 0:
        return "emergency"
    return "high" if index % 5 == 0 else "normal"


def _fault_description(
    fault: dict[str, Any], machine: dict[str, Any], work_type: str, related: bool
) -> str:
    details = {
        "MECH-001": "Осмотреть опоры приводной секции, заменить ролик с заметным радиальным биением.",
        "MECH-002": "Устранить увод ленты на хвостовом барабане и проверить центровку после пуска.",
        "MECH-003": "Проверить люфт подшипникового узла и температуру корпуса под нагрузкой.",
        "MECH-004": "Подтянуть крепления рамы и нанести контрольные метки на критические соединения.",
        "MECH-005": "Диагностировать шум редуктора, проверить уровень смазки и зацепление.",
        "ELEC-001": "Проверить токи фаз и клеммные соединения двигателя, устранить причину нагрева.",
        "ELEC-002": "Локализовать повреждение силовой линии, восстановить изоляцию и прозвонить цепь.",
        "ELEC-003": "Проверить цепь датчика и сигнал в шкафу управления, восстановить устойчивое показание.",
        "ELEC-004": "Проверить контактор пуска, состояние катушки и силовых контактов.",
        "ELEC-005": "Измерить напряжение на вводе и контактах нагрузки, проверить затяжку соединений.",
        "HYD-001": "Найти место утечки в контуре, заменить уплотнение или рукав по состоянию.",
        "HYD-002": "Проверить давление, фильтрацию и настройку предохранительного клапана.",
        "HYD-003": "Осмотреть рукав высокого давления на трещины и заменить повреждённый участок.",
        "HYD-004": "Проверить перепад давления на фильтре и заменить загрязнённый элемент.",
        "HYD-005": "Проверить температуру масла, радиатор и работу вентилятора охлаждения.",
        "GEN-001": "Очистить узел от налипшего материала и подтвердить свободный ход защитных элементов.",
        "GEN-002": "Провести регламентный осмотр, проверить ограждения, крепления и отсутствие утечек.",
        "GEN-003": "Отрегулировать привод по нормативу и выполнить контрольный запуск без нагрузки.",
        "GEN-004": "Заменить смазку в обслуживаемом узле и проверить отсутствие перегрева.",
        "GEN-005": "Проверить ограждение, крепёж и блокировки; устранить выявленное отклонение.",
    }
    prefix = "Повторный вызов после недавнего обслуживания. " if related else ""
    kind = "Плановое обслуживание." if work_type == "planned" else "Корректирующий ремонт."
    return f"{prefix}{kind} {machine['name']} ({machine['inventory_number']}): {details[fault['code']]}"


def _work_done(fault: dict[str, Any], machine: dict[str, Any]) -> str:
    reports = {
        "MECH-001": "Заменён ролик, выставлена опора; после запуска биение не наблюдается.",
        "MECH-002": "Заменён изношенный участок ленты и отрегулирована центровка; схода нет.",
        "MECH-003": "Заменён подшипник, заложена смазка; температура корпуса стабильна.",
        "MECH-004": "Заменены ослабленные болты, крепления протянуты с контрольной отметкой.",
        "MECH-005": "Заменён подшипник, обновлена смазка редуктора; шум после пуска отсутствует.",
        "ELEC-001": "Заменён подгоревший контактор, клеммы протянуты, токи фаз выровнены.",
        "ELEC-002": "Повреждённый участок кабеля восстановлен, изоляция и прозвонка соответствуют норме.",
        "ELEC-003": "Восстановлена цепь датчика; сигнал в шкафу управления устойчивый.",
        "ELEC-004": "Заменён неисправный контактор, выполнен пробный пуск под нагрузкой.",
        "ELEC-005": "Проверены ввод и соединения; отклонение напряжения на нагрузке не повторилось.",
        "HYD-001": "Заменён повреждённый рукав, уровень масла восстановлен, утечек нет.",
        "HYD-002": "Проверены фильтрация и настройка клапана; давление стабилизировано.",
        "HYD-003": "Заменён повреждённый рукав, соединения опрессованы без подтёков.",
        "HYD-004": "Заменён фильтрующий элемент, перепад давления приведён к рабочему значению.",
        "HYD-005": "Очищен радиатор и добавлено масло; перегрев после проверки не повторился.",
        "GEN-001": "Узел очищен, свободный ход и защитные элементы проверены.",
        "GEN-002": "Регламентный осмотр завершён; замечаний, требующих ремонта, не выявлено.",
        "GEN-003": "Привод отрегулирован, добавлена смазка, контрольный запуск штатный.",
        "GEN-004": "Смазка заменена в требуемом объёме, перегрев на контрольной работе отсутствует.",
        "GEN-005": "Ограждение закреплено, блокировки проверены в присутствии мастера.",
    }
    return f"{machine['inventory_number']}: {reports[fault['code']]}"


def _comment(status: str, attempt: int, priority: str) -> str | None:
    if status == "paused":
        return "Пауза согласована: ожидание технологического допуска для безопасного продолжения."
    if status == "rejected":
        return "Назначение снято: исполнитель сообщил об отсутствии допуска к изолированной зоне."
    if attempt == 2:
        return "После замечания мастера выполнена повторная регулировка и контрольный запуск."
    if priority == "emergency":
        return "Аварийный приоритет подтверждён мастером по влиянию на непрерывность процесса."
    return None


def _no_materials_reason(
    fault: dict[str, Any], work_type: str, index: int, submission: int | None
) -> str | None:
    if submission is None:
        return None
    if fault["code"] in {"GEN-001", "GEN-002", "GEN-005", "ELEC-003", "ELEC-005"}:
        return "Замечание устранено регулировкой и проверкой; расходные материалы не потребовались."
    if work_type == "planned" and index % 3 == 0:
        return "Регламентный осмотр выполнен без замены деталей; материалы не потребовались."
    return None


def _materials_for(
    code: str, materials: list[dict[str, Any]], index: int, needed: bool
) -> list[tuple[dict[str, Any], Decimal]]:
    if not needed:
        return []
    words = {
        "MECH-001": ("ролик",),
        "MECH-002": ("лента",),
        "MECH-003": ("подшипник", "смазка"),
        "MECH-004": ("крепёж",),
        "MECH-005": ("подшипник", "смазка"),
        "ELEC-001": ("контактор",),
        "ELEC-002": ("кабель",),
        "ELEC-004": ("контактор",),
        "HYD-001": ("рукав",),
        "HYD-002": ("фильтр",),
        "HYD-003": ("рукав",),
        "HYD-004": ("фильтр",),
        "HYD-005": ("масло",),
        "GEN-003": ("смазка",),
        "GEN-004": ("смазка",),
    }.get(code, ())
    rows: list[tuple[dict[str, Any], Decimal]] = []
    for offset, word in enumerate(words):
        choices = [row for row in materials if row["name"].lower().startswith(word)]
        if not choices:
            raise ValueError(f"No material containing {word!r} for {code}")
        material = choices[(index + offset) % len(choices)]
        quantity = (
            Decimal("1")
            if word not in {"лента", "кабель", "масло", "смазка"}
            else Decimal(2 + (index + offset) % 3)
        )
        rows.append((material, quantity))
    merged: dict[UUID, tuple[dict[str, Any], Decimal]] = {}
    for material, quantity in rows:
        previous = merged.get(material["id"])
        merged[material["id"]] = (
            material,
            quantity if previous is None else previous[1] + quantity,
        )
    return list(merged.values())


def _timeline(
    order: dict[str, Any],
    executor: dict[str, Any],
    previous_executor: dict[str, Any],
    master: dict[str, Any],
    ident: Any,
    index: int,
    related: bool,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def add(
        actor: dict[str, Any] | None,
        role: str,
        action: str,
        before: str | None,
        after: str,
        at: datetime,
        *,
        reason: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        rows.append(
            {
                "id": ident("event", f"{order['id']}:{len(rows) + 1}"),
                "work_order_id": order["id"],
                "sequence": len(rows) + 1,
                "order_version": None,
                "details": {"source": _SOURCE, **(details or {})},
                "actor_id": None if actor is None else actor["id"],
                "actor_role": role,
                "action": action,
                "from_status": before,
                "to_status": after,
                "occurred_at": at,
                "reason": reason,
            }
        )

    issued = order["issued_at"]
    add(
        master,
        "master",
        "issue",
        None,
        "issued",
        issued,
        reason="Наряд зарегистрирован мастером смены",
    )
    status = order["status"]
    if status == "issued":
        return _finalize_versions(rows)
    if status == "queued":
        add(executor, "executor", "queue", "issued", "queued", issued + timedelta(minutes=12))
        return _finalize_versions(rows)
    if status == "rejected":
        add(
            executor,
            "executor",
            "reject",
            "issued",
            "rejected",
            issued + timedelta(minutes=10),
            reason="Нет действующего допуска к изолированной зоне оборудования",
        )
        return _finalize_versions(rows)
    rejected = status not in {"issued", "queued"} and index % 61 == 7
    if rejected:
        add(
            previous_executor,
            "executor",
            "reject",
            "issued",
            "rejected",
            issued + timedelta(minutes=10),
            reason="Требуется уточнить технологическое окно для безопасного ремонта",
        )
        rejection_id = rows[-1]["id"]
        add(
            master,
            "master",
            "adjudicate_refusal",
            "rejected",
            "rejected",
            issued + timedelta(minutes=25),
            reason="Отказ обоснован и рассмотрен мастером",
            details={"rejection_event_id": str(rejection_id), "justified": True},
        )
        add(
            master,
            "master",
            "reassign",
            "rejected",
            "issued",
            issued + timedelta(minutes=30),
            reason="Назначен исполнитель с требуемым допуском",
            details={
                "executor_id": str(executor["id"]),
                "previous_executor_id": str(previous_executor["id"]),
            },
        )
    accepted = issued + timedelta(minutes=42 if rejected else 14)
    if rejected and isinstance(order["started_at"], datetime):
        accepted = min(accepted, order["started_at"] - timedelta(minutes=1))
    add(executor, "executor", "accept", "issued", "accepted", accepted)
    if status == "accepted":
        return _finalize_versions(rows)
    started = order["started_at"]
    assert isinstance(started, datetime)
    add(executor, "executor", "start", "accepted", "in_progress", started)
    if status == "in_progress":
        return _finalize_versions(rows)
    if status == "paused":
        add(
            executor,
            "executor",
            "pause",
            "in_progress",
            "paused",
            started + timedelta(minutes=35),
            reason="Ожидание технологического допуска для продолжения безопасной работы",
        )
        return _finalize_versions(rows)
    completed = order["completed_at"]
    assert isinstance(completed, datetime)
    if order["attempt"] == 2:
        first_complete = started + (completed - started) / 2
        add(executor, "executor", "complete", "in_progress", "completed", first_complete)
        add(
            master,
            "master",
            "request_rework",
            "completed",
            "rework",
            first_complete + timedelta(minutes=8),
            reason="Контрольный запуск выявил необходимость дополнительной регулировки",
        )
        add(
            executor,
            "executor",
            "start",
            "rework",
            "in_progress",
            first_complete + timedelta(minutes=20),
        )
    add(executor, "executor", "complete", "in_progress", "completed", completed)
    if status == "completed":
        return _finalize_versions(rows)
    add(
        master,
        "master",
        "manual_review",
        "completed",
        "ai_review",
        completed + timedelta(minutes=5),
        reason="Итоговая приёмка мастером без автоматической проверки",
    )
    if status == "ai_review":
        return _finalize_versions(rows)
    if status == "rework":
        add(
            master,
            "master",
            "request_rework",
            "ai_review",
            "rework",
            completed + timedelta(minutes=8),
            reason="Работа возвращена на доработку после очной проверки мастером",
        )
        return _finalize_versions(rows)
    closed = order["closed_at"]
    assert isinstance(closed, datetime)
    add(
        master,
        "master",
        "override_close",
        "ai_review",
        "closed",
        closed,
        reason="Работа принята мастером после очного контрольного запуска",
    )
    return _finalize_versions(rows)


def _finalize_versions(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for version, row in enumerate(rows, start=1):
        row["sequence"] = version
        row["order_version"] = version
        if row["action"] == "complete":
            row["details"]["submission_version"] = version
    return rows


def _last_completion_version(rows: list[dict[str, Any]]) -> int | None:
    return next(
        (row["order_version"] for row in reversed(rows) if row["action"] == "complete"), None
    )


def _manual_review(
    ident: Any, order: dict[str, Any], completed: datetime, submission: int, index: int
) -> dict[str, Any]:
    return {
        "id": ident("manual_review", f"{order['id']}:{submission}"),
        "work_order_id": order["id"],
        "order_version": submission,
        "verdict": None,
        "score": None,
        "needs_master_review": False,
        "explanation": "Архивная приёмка мастером. Автоматическая проверка не выполнялась.",
        "model_name": "manual-history",
        "created_at": completed + timedelta(minutes=5),
        "master_score": 3 + index % 3,
        "report": {
            "source": "unavailable",
            "fixture_source": _SOURCE,
            "provider_invoked": False,
            "photos_checked": False,
            "assessment": "manual",
        },
    }


def _link_close_event(events: list[dict[str, Any]], review_id: UUID) -> None:
    for event in reversed(events):
        if event["action"] == "override_close":
            event["details"]["review_id"] = str(review_id)
            return


def _add_downtime(
    events: list[dict[str, Any]],
    ident: Any,
    order: dict[str, Any],
    master: dict[str, Any],
    completed: datetime,
    index: int,
) -> None:
    order_events = [row for row in events if row["work_order_id"] == order["id"]]
    last_event_at = max(row["occurred_at"] for row in order_events)
    started = completed - timedelta(minutes=25 + index % 40)
    ended = completed - timedelta(minutes=5)
    order_version = order["version"] + 1
    events.append(
        {
            "id": ident("downtime", str(order["id"])),
            "work_order_id": order["id"],
            "sequence": len(order_events) + 1,
            "order_version": order_version,
            "details": {
                "source": _SOURCE,
                "started_at": started.isoformat(),
                "ended_at": ended.isoformat(),
                "reason": "Остановка оборудования на время диагностики и безопасного ремонта",
                "void": False,
            },
            "actor_id": master["id"],
            "actor_role": "master",
            "action": "record_downtime",
            "from_status": order["status"],
            "to_status": order["status"],
            "occurred_at": last_event_at + timedelta(minutes=3),
            "reason": "Простой подтверждён мастером по сменному журналу",
        }
    )
    order["version"] = order_version


def _assert_order_times(order: dict[str, Any], anchor: datetime) -> None:
    if order["issued_at"] > anchor:
        raise ValueError("Synthetic order issuance cannot be in the future")
    for field in ("started_at", "completed_at", "closed_at"):
        if order[field] is not None and order[field] > anchor:
            raise ValueError(f"Synthetic {field} cannot be in the future")


def _validate_catalog(catalog: dict[str, list[dict[str, Any]]]) -> None:
    required = {
        "equipment": {"id", "inventory_number", "name", "area_id", "equipment_type"},
        "fault_codes": {"id", "code", "name", "specialty"},
        "materials": {"id", "code", "name"},
        "employees": {"id", "role", "specialty"},
    }
    for table, fields in required.items():
        rows = catalog.get(table)
        if not isinstance(rows, list) or not rows:
            raise ValueError(f"catalog must include non-empty {table}")
        if any(not fields.issubset(row) for row in rows):
            raise ValueError(f"catalog {table} lacks required fields")
    faults = {row["code"] for row in catalog["fault_codes"]}
    unknown = faults - set(_FAULT_TYPES)
    if unknown:
        raise ValueError(f"catalog contains unsupported fault codes: {sorted(unknown)!r}")
    if not any(row["role"] == "master" for row in catalog["employees"]):
        raise ValueError("catalog must include a master")
    for specialty in {row["specialty"] for row in catalog["fault_codes"]}:
        if not any(
            row["role"] == "executor" and row["specialty"] == specialty
            for row in catalog["employees"]
        ):
            raise ValueError(f"catalog has no executor for specialty {specialty}")


def _require_aware(value: datetime) -> None:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("anchor must be timezone-aware")


def _require_seed(seed: int) -> None:
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise TypeError("seed must be an integer")
