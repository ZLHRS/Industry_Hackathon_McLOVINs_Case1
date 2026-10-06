# ruff: noqa: RUF001
"""Pure, removable industrial maintenance history fixture; it performs no I/O."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from random import Random
from typing import Any
from uuid import UUID, uuid5

from .catalog import FAULTS, build_catalog

_NAMESPACE = UUID("9ed79fe7-25ed-5c36-a204-df9cec1fd1fb")
_SOURCE = "synthetic_industrial_fixture"


def generate_dataset(*, anchor: datetime, seed: int = 2026) -> dict[str, list[dict[str, Any]]]:
    """Build deterministic catalog and history rows for the industrial seed package."""
    _require_utc(anchor)
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise TypeError("seed must be an integer")
    random = Random(seed)

    def ident(kind: str, key: str) -> UUID:
        return uuid5(_NAMESPACE, f"industrial-v1:{seed}:{kind}:{key}")

    data = build_catalog(ident)
    rows = _history(ident, random, anchor, data)
    data.update(rows)
    return data


def _history(
    ident: Any, random: Random, anchor: datetime, catalog: dict[str, list[dict[str, Any]]]
) -> dict[str, list[dict[str, Any]]]:
    equipment = catalog["equipment"]
    faults = catalog["fault_codes"]
    materials = catalog["materials"]
    employees = catalog["employees"]
    executors = [row for row in employees if row["role"] == "executor"]
    masters = [row for row in employees if row["role"] == "master"]
    compatible = {code: set(types) for code, _, _, types in FAULTS}
    work_orders: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    usages: list[dict[str, Any]] = []
    reviews: list[dict[str, Any]] = []
    availability: dict[UUID, datetime] = {}
    start_day = (anchor - timedelta(days=120)).date()
    hot_conveyors = {equipment[0]["id"], equipment[1]["id"]}
    planned_recent: list[tuple[dict[str, Any], dict[str, Any], datetime]] = []
    active_executor_ids: set[UUID] = set()

    for index in range(600):
        number = f"НР-{anchor.year}-{index + 1:04d}"
        current = index >= 588
        status = _current_status(index) if current else "closed"
        machine, fault, work_type, related = _select_work(
            index, random, equipment, faults, compatible, hot_conveyors, planned_recent
        )
        if work_type == "planned":
            planned_recent.append(
                (machine, fault, datetime.combine(start_day, datetime.min.time(), UTC))
            )
        executor = _executor(index, executors, status, fault)
        if current and status in {"in_progress", "paused"}:
            executor = _available_active_executor(
                index, executors, fault["specialty"], active_executor_ids
            )
            active_executor_ids.add(executor["id"])
        previous_executor = _prior_executor(executor, executors, fault["specialty"])
        master = masters[index % len(masters)]
        candidate = datetime.combine(
            start_day + timedelta(days=(index * 117) // 587), datetime.min.time(), UTC
        ) + timedelta(hours=6 + (index * 29) % 12, minutes=(index * 7) % 45)
        if current:
            candidate = anchor - timedelta(hours=42 - 2 * (index - 588))
        started = max(
            candidate,
            availability.get(machine["id"], candidate),
            availability.get(executor["id"], candidate),
        )
        if started.hour >= 19:
            started = datetime.combine(
                (started + timedelta(days=1)).date(), datetime.min.time(), UTC
            ) + timedelta(hours=6)
        issued = started - timedelta(minutes=45 + index % 120)
        duration = timedelta(minutes=45 + (index * 17) % 150)
        completed = started + duration
        availability[machine["id"]] = completed + timedelta(minutes=10)
        availability[executor["id"]] = completed + timedelta(minutes=10)
        deadline = started + duration + timedelta(minutes=30 if index % 4 < 2 else 90)
        if not current and index % 11 == 0:
            deadline = completed - timedelta(minutes=20)
        if current:
            deadline = anchor + timedelta(hours=2 if index % 2 == 0 else -2)
        attempt = 2 if status == "rework" or (not current and index % 47 == 0) else 1
        submission = attempt if status in {"closed", "completed", "ai_review", "rework"} else None
        order = {
            "id": ident("work_order", str(index + 1)),
            "number": number,
            "work_type": work_type,
            "description": f"{fault['name']} на оборудовании {machine['inventory_number']}",
            "area_id": machine["area_id"],
            "equipment_id": machine["id"],
            "executor_id": executor["id"],
            "master_id": master["id"],
            "priority": "planned"
            if work_type == "planned"
            else ("emergency", "high", "normal")[index % 3],
            "status": status,
            "issued_at": issued,
            "deadline": deadline,
            "started_at": None
            if status in {"issued", "accepted", "queued", "rejected"}
            else started,
            "completed_at": completed if submission else None,
            "closed_at": completed + timedelta(minutes=20) if status == "closed" else None,
            "fault_code_id": fault["id"],
            "work_description": _work_done(fault["name"], fault["specialty"])
            if submission
            else None,
            "comment": "Требуется контрольная проверка после регулировки."
            if attempt == 2
            else None,
            "version": 1,
            "attempt": attempt,
            "last_submission_version": None,
            "no_materials_reason": "Расходные материалы не потребовались."
            if index % 11 == 0
            else None,
            "is_synthetic": True,
        }
        work_orders.append(order)
        timeline = _timeline(order, executor, previous_executor, master, ident, index, related)
        events.extend(timeline)
        completion_version = _last_completion_version(timeline)
        order["last_submission_version"] = completion_version
        order["version"] = timeline[-1]["order_version"]
        if completion_version is not None:
            if status == "closed":
                review = _manual_review(ident, order, completed, master, completion_version, index)
                reviews.append(review)
                _link_close_event(timeline, review["id"])
            for part in range(0 if order["no_materials_reason"] else 1 + index % 3):
                material = _material_for(fault["code"], materials, index + part)
                quantity = Decimal(1 + (index + part) % 3)
                if machine["id"] in hot_conveyors and index % 23 == 0 and part == 0:
                    quantity = Decimal("8")
                usages.append(
                    {
                        "id": ident("usage", f"{index + 1}:{completion_version}:{part}"),
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


def _select_work(
    index: int,
    random: Random,
    equipment: list[dict[str, Any]],
    faults: list[dict[str, Any]],
    compatible: dict[str, set[str]],
    hot: set[UUID],
    planned: list[tuple[dict[str, Any], dict[str, Any], datetime]],
) -> tuple[dict[str, Any], dict[str, Any], str, bool]:
    repeated = index % 24 == 1 and planned
    if repeated:
        machine, fault, _ = planned[-1]
        return machine, fault, "unplanned", True
    machine = equipment[index % 2] if index % 19 == 0 else random.choice(equipment)
    eligible = [fault for fault in faults if machine["equipment_type"] in compatible[fault["code"]]]
    if machine["id"] in hot and index % 4 == 0:
        eligible = [fault for fault in eligible if fault["code"].startswith("MECH")]
    return machine, random.choice(eligible), "planned" if index % 4 == 0 else "unplanned", False


def _executor(
    index: int,
    executors: list[dict[str, Any]],
    status: str,
    fault: dict[str, Any],
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
    index: int,
    executors: list[dict[str, Any]],
    specialty: str,
    active_executor_ids: set[UUID],
) -> dict[str, Any]:
    available = [
        row
        for row in executors
        if row["specialty"] == specialty and row["id"] not in active_executor_ids
    ]
    if not available:
        raise ValueError(f"No available executor for active {specialty} work")
    return available[index % len(available)]


def _current_status(index: int) -> str:
    return (
        "issued",
        "accepted",
        "queued",
        "in_progress",
        "paused",
        "completed",
        "ai_review",
        "rework",
    )[index % 8]


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
        order_version: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        rows.append(
            {
                "id": ident("event", f"{order['id']}:{len(rows) + 1}"),
                "work_order_id": order["id"],
                "sequence": len(rows) + 1,
                "order_version": order_version,
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
    add(master, "master", "issue", None, "issued", issued, reason="Плановая регистрация работы")
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
            reason="Требуется допуск к оборудованию",
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
            reason="Требуется уточнение условий работы",
        )
        rejection_id = rows[-1]["id"]
        add(
            master,
            "master",
            "adjudicate_refusal",
            "rejected",
            "rejected",
            issued + timedelta(minutes=25),
            reason="Отказ рассмотрен мастером",
            details={"rejection_event_id": str(rejection_id), "justified": index % 2 == 0},
        )
        add(
            master,
            "master",
            "reassign",
            "rejected",
            "issued",
            issued + timedelta(minutes=30),
            reason="Назначен исполнитель с необходимым допуском",
            details={
                "executor_id": str(executor["id"]),
                "previous_executor_id": str(previous_executor["id"]),
            },
        )
    accepted = issued + timedelta(minutes=42 if rejected else 14)
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
            started + timedelta(minutes=20),
            reason="Ожидание технологического допуска",
        )
        return _finalize_versions(rows)
    completed = order["completed_at"]
    assert isinstance(completed, datetime)
    attempt = order["attempt"]
    if attempt == 2:
        first_complete = started + (completed - started) / 2
        add(
            executor,
            "executor",
            "complete",
            "in_progress",
            "completed",
            first_complete,
            order_version=1,
            details={"submission_version": 1},
        )
        add(
            master,
            "master",
            "request_rework",
            "completed",
            "rework",
            first_complete + timedelta(minutes=8),
            reason="Нужна дополнительная регулировка",
            order_version=1,
        )
        add(
            executor,
            "executor",
            "start",
            "rework",
            "in_progress",
            first_complete + timedelta(minutes=20),
            order_version=2,
        )
    add(
        executor,
        "executor",
        "complete",
        "in_progress",
        "completed",
        completed,
        order_version=attempt,
        details={"submission_version": attempt},
    )
    if status == "completed":
        return _finalize_versions(rows)
    add(
        master,
        "master",
        "manual_review",
        "completed",
        "ai_review",
        completed + timedelta(minutes=5),
        order_version=attempt,
        reason="Итоговая оценка мастера",
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
            reason="Работа ожидает повторного выполнения",
            order_version=attempt,
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
        reason="Работа принята мастером",
        order_version=attempt,
    )
    return _finalize_versions(rows)


def _finalize_versions(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Assign an immutable, monotonic order version to every historical event."""
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
    ident: Any,
    order: dict[str, Any],
    completed: datetime,
    master: dict[str, Any],
    submission: int,
    index: int,
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
    started = completed - timedelta(minutes=20 + index % 55)
    ended = completed - timedelta(minutes=5)
    sequence = len(order_events) + 1
    order_version = order["version"] + 1
    events.append(
        {
            "id": ident("downtime", str(order["id"])),
            "work_order_id": order["id"],
            "sequence": sequence,
            "order_version": order_version,
            "details": {
                "source": _SOURCE,
                "started_at": started.isoformat(),
                "ended_at": ended.isoformat(),
                "reason": "Остановка оборудования на время диагностики",
                "void": False,
            },
            "actor_id": master["id"],
            "actor_role": "master",
            "action": "record_downtime",
            "from_status": order["status"],
            "to_status": order["status"],
            "occurred_at": last_event_at + timedelta(minutes=3),
            "reason": "Простой подтверждён мастером",
        }
    )
    order["version"] = order_version


def _require_utc(value: datetime) -> None:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("anchor must be timezone-aware UTC")


def _work_done(fault_name: str, specialty: str) -> str:
    actions = {
        "механик": "выполнены регулировка и замена изношенного элемента",
        "электрик": "выполнены диагностика цепи и восстановление соединения",
        "гидравлик": "выполнены осмотр контура и устранение негерметичности",
        "универсал": "выполнены осмотр, очистка и контрольная регулировка",
    }
    return f"По неисправности «{fault_name}» {actions[specialty]}; проведён контрольный запуск."


def _material_for(code: str, materials: list[dict[str, Any]], position: int) -> dict[str, Any]:
    # Compatible families per repair: conveyor parts never appear on a pump or truck.
    families = {
        "MECH-001": {3},
        "MECH-002": {4},
        "MECH-003": {2, 5},
        "MECH-004": {1},
        "MECH-005": {2, 5},
        "ELEC-001": {9},
        "ELEC-002": {9},
        "ELEC-003": {9},
        "ELEC-004": {0, 9},
        "ELEC-005": {9},
        "HYD-001": {6, 7},
        "HYD-002": {6, 8},
        "HYD-003": {7},
        "HYD-004": {8},
        "HYD-005": {6, 8},
        "GEN-001": {5},
        "GEN-002": {5},
        "GEN-003": {1, 5},
        "GEN-004": {5},
        "GEN-005": {1},
    }
    allowed = [row for row in materials if int(row["code"].split("-", 1)[1]) % 10 in families[code]]
    return allowed[position % len(allowed)]
