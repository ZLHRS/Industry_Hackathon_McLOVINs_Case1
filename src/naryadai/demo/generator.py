# ruff: noqa: RUF001
"""Pure reproducible generator for the labelled ТехНаряд demo dataset.

The persisted rows contain operational facts only.  ``ground_truth`` is deliberately
kept outside those rows so analytics cannot accidentally read the answers.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from random import Random
from typing import Any
from uuid import UUID, uuid5

_NAMESPACE = UUID("158e4dd4-519a-51af-8d79-3ac0cfbd9e39")
_DEMO = "ДЕМО: синтетические данные. "

EventStep = tuple[dict[str, Any] | None, str, str, str | None, str, datetime, str | None]


@dataclass(frozen=True, slots=True)
class DemoPattern:
    """Expected analytic signal, never persisted as an operational row field."""

    key: str
    title: str
    evidence_order_numbers: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DemoDataset:
    """Serializable records plus separate answer key for demonstration checks."""

    seed: int
    anchor_date: date
    areas: tuple[dict[str, Any], ...]
    brigades: tuple[dict[str, Any], ...]
    equipment: tuple[dict[str, Any], ...]
    employees: tuple[dict[str, Any], ...]
    employee_areas: tuple[dict[str, Any], ...]
    fault_codes: tuple[dict[str, Any], ...]
    materials: tuple[dict[str, Any], ...]
    time_norms: tuple[dict[str, Any], ...]
    work_orders: tuple[dict[str, Any], ...]
    events: tuple[dict[str, Any], ...]
    material_usages: tuple[dict[str, Any], ...]
    ai_reviews: tuple[dict[str, Any], ...]
    ground_truth: tuple[DemoPattern, ...]


def generate_demo_dataset(*, anchor_date: date, seed: int = 42) -> DemoDataset:
    """Return a stable synthetic fixture for a calendar anchor and integer seed."""
    if not isinstance(anchor_date, date) or isinstance(anchor_date, datetime):
        raise TypeError("anchor_date must be a date")
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise TypeError("seed must be an integer")
    random = Random(seed)

    def ident(kind: str, key: str) -> UUID:
        return _id(seed, kind, key)

    areas = tuple(
        _row(id=ident("area", code), code=code, name=name)
        for code, name in (
            ("CRUSH", "Дробильно-сортировочный участок"),
            ("MINE", "Горный участок"),
            ("TRANSPORT", "Транспортный участок"),
            ("ENERGY", "Энергетический участок"),
        )
    )
    area_by_code = {item["code"]: item["id"] for item in areas}
    brigades = tuple(
        _row(id=ident("brigade", code), code=code, name=name)
        for code, name in (
            ("BR-01", "Бригада ДЕМО Альфа"),
            ("BR-02", "Бригада ДЕМО Бета"),
            ("BR-03", "Бригада ДЕМО Гамма"),
        )
    )
    brigade_by_code = {item["code"]: item["id"] for item in brigades}
    equipment = _equipment(ident, area_by_code)
    faults = _fault_codes(ident)
    materials = _materials(ident)
    employees = _employees(ident, brigade_by_code)
    employee_areas = tuple(
        _row(employee_id=person["id"], area_id=area["id"])
        for person in employees
        if person["role"] in {"master", "executor", "manager"}
        for area in areas
    )
    norms = tuple(
        _row(
            id=ident("norm", f"{fault['code']}:{kind}"),
            fault_code_id=fault["id"],
            equipment_type=kind,
            minutes=45 + ((position * 17 + len(kind) * 11) % 150),
        )
        for position, fault in enumerate(faults)
        for kind in ("conveyor", "crusher", "excavator", "truck", "pump")
    )
    orders, events, usages, reviews, patterns = _orders(
        ident, random, anchor_date, equipment, employees, faults, materials
    )
    return DemoDataset(
        seed=seed,
        anchor_date=anchor_date,
        areas=areas,
        brigades=brigades,
        equipment=equipment,
        employees=employees,
        employee_areas=employee_areas,
        fault_codes=faults,
        materials=materials,
        time_norms=norms,
        work_orders=orders,
        events=events,
        material_usages=usages,
        ai_reviews=reviews,
        ground_truth=patterns,
    )


def _id(seed: int, kind: str, key: str) -> UUID:
    return uuid5(_NAMESPACE, f"naryadai-demo:{seed}:{kind}:{key}")


def _row(**values: Any) -> dict[str, Any]:
    return values


def _equipment(ident: Any, area_by_code: dict[str, UUID]) -> tuple[dict[str, Any], ...]:
    specs = (
        ("CRUSH", "conveyor", "Конвейер", 7),
        ("CRUSH", "crusher", "Дробилка", 5),
        ("MINE", "excavator", "Экскаватор", 4),
        ("MINE", "pump", "Насос", 3),
        ("TRANSPORT", "truck", "Самосвал", 4),
        ("ENERGY", "pump", "Насос", 2),
    )
    rows: list[dict[str, Any]] = []
    index = 1
    for area, kind, title, count in specs:
        for number in range(1, count + 1):
            inventory = f"ДЕМО-{area[:2]}-{index:03d}"
            rows.append(
                _row(
                    id=ident("equipment", inventory),
                    inventory_number=inventory,
                    name=f"{title} ДЕМО {number}",
                    area_id=area_by_code[area],
                    equipment_type=kind,
                    criticality=1 + ((index * 3) % 5),
                )
            )
            index += 1
    return tuple(rows)


def _fault_codes(ident: Any) -> tuple[dict[str, Any], ...]:
    names = (
        ("MECH-001", "Износ ролика", "механик"),
        ("MECH-002", "Обрыв ленты", "механик"),
        ("MECH-003", "Люфт подшипника", "механик"),
        ("MECH-004", "Ослабление крепежа", "механик"),
        ("MECH-005", "Шум редуктора", "механик"),
        ("ELEC-001", "Перегрев двигателя", "электрик"),
        ("ELEC-002", "Обрыв кабеля", "электрик"),
        ("ELEC-003", "Сбой датчика", "электрик"),
        ("ELEC-004", "Неисправность пускателя", "электрик"),
        ("ELEC-005", "Падение напряжения", "электрик"),
        ("HYD-001", "Утечка масла", "гидравлик"),
        ("HYD-002", "Падение давления", "гидравлик"),
        ("HYD-003", "Износ шланга", "гидравлик"),
        ("HYD-004", "Засорение фильтра", "гидравлик"),
        ("HYD-005", "Перегрев гидросистемы", "гидравлик"),
        ("GEN-001", "Очистка узла", "универсал"),
        ("GEN-002", "Плановый осмотр", "универсал"),
        ("GEN-003", "Регулировка привода", "универсал"),
        ("GEN-004", "Замена смазки", "универсал"),
        ("GEN-005", "Проверка ограждения", "универсал"),
    )
    return tuple(
        _row(id=ident("fault", code), code=code, name=f"ДЕМО: {name}", specialty=specialty)
        for code, name, specialty in names
    )


def _materials(ident: Any) -> tuple[dict[str, Any], ...]:
    categories = ("болт", "гайка", "шайба", "ролик", "лента", "подшипник", "смазка", "масло")
    units = ("шт", "шт", "шт", "шт", "м", "шт", "кг", "л")
    return tuple(
        _row(
            id=ident("material", f"MAT-{n:03d}"),
            code=f"MAT-{n:03d}",
            name=f"ДЕМО материал: {categories[(n - 1) % len(categories)]} {n}",
            unit=units[(n - 1) % len(units)],
        )
        for n in range(1, 41)
    )


def _employees(ident: Any, brigade_by_code: dict[str, UUID]) -> tuple[dict[str, Any], ...]:
    people: list[dict[str, Any]] = []
    for index in range(1, 3):
        login = f"demo.master{index}"
        people.append(
            _row(
                id=ident("employee", login),
                login=login,
                display_name=f"ДЕМО Мастер {index}",
                role="master",
                specialty="мастер ремонта",
                grade=6,
                brigade_id=None,
                is_active=True,
                is_on_shift=True,
            )
        )
    specialties = ("механик", "электрик", "гидравлик", "универсал", "механик")
    for index in range(1, 16):
        login = f"demo.executor{index:02d}"
        people.append(
            _row(
                id=ident("employee", login),
                login=login,
                display_name=f"ДЕМО Исполнитель {index:02d}",
                role="executor",
                specialty=specialties[(index - 1) % 5],
                grade=3 + index % 3,
                brigade_id=brigade_by_code[f"BR-{((index - 1) // 5) + 1:02d}"],
                is_active=True,
                is_on_shift=True,
            )
        )
    for login, role, name in (
        ("demo.manager", "manager", "ДЕМО Руководитель"),
        ("demo.admin", "admin", "ДЕМО Администратор"),
    ):
        people.append(
            _row(
                id=ident("employee", login),
                login=login,
                display_name=name,
                role=role,
                specialty="администрирование",
                grade=5,
                brigade_id=None,
                is_active=True,
                is_on_shift=True,
            )
        )
    return tuple(people)


def _orders(
    ident: Any,
    random: Random,
    anchor: date,
    equipment: tuple[dict[str, Any], ...],
    employees: tuple[dict[str, Any], ...],
    faults: tuple[dict[str, Any], ...],
    materials: tuple[dict[str, Any], ...],
) -> tuple[
    tuple[dict[str, Any], ...],
    tuple[dict[str, Any], ...],
    tuple[dict[str, Any], ...],
    tuple[dict[str, Any], ...],
    tuple[DemoPattern, ...],
]:
    executors = [item for item in employees if item["role"] == "executor"]
    masters = [item for item in employees if item["role"] == "master"]
    start_date = anchor - timedelta(days=122)
    availability: dict[UUID, datetime] = {}
    orders: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    usages: list[dict[str, Any]] = []
    reviews: list[dict[str, Any]] = []
    hot: list[str] = []
    overuse: list[str] = []
    followup: list[str] = []
    rework: list[str] = []
    conveyor_ids = {equipment[0]["id"], equipment[1]["id"]}
    planned_targets: list[tuple[dict[str, Any], dict[str, Any], date]] = []
    for index in range(600):
        number = f"DEMO-{anchor.year}-{index + 1:04d}"
        desired_day = start_date + timedelta(days=(index * 119) // 599)
        is_followup = index % 20 == 1 and planned_targets
        if is_followup:
            base_equipment, fault, earlier = planned_targets[-1]
            machine = base_equipment
            work_type = "unplanned"
            fault_code = fault
            desired_day = earlier + timedelta(days=3)
            followup.append(number)
        else:
            machine = equipment[index % 2] if index % 17 == 0 else random.choice(equipment)
            work_type = "planned" if index % 4 == 0 else "unplanned"
            fault_code = (
                faults[index % 5]
                if machine["id"] in conveyor_ids and index % 3 == 0
                else random.choice(faults)
            )
        if work_type == "planned":
            planned_targets.append((machine, fault_code, desired_day))
        executor = (
            executors[14]
            if index >= 560 and index % 7 == 6
            else executors[(index * 7 + random.randrange(5)) % len(executors)]
        )
        master = masters[index % len(masters)]
        candidate = datetime.combine(desired_day, datetime.min.time(), UTC) + timedelta(
            hours=7 + (index * 37) % 9
        )
        started = max(
            candidate,
            availability.get(machine["id"], candidate),
            availability.get(executor["id"], candidate),
        )
        if started.hour >= 18:
            started = datetime.combine(
                (started + timedelta(days=1)).date(), datetime.min.time(), UTC
            ) + timedelta(hours=7)
        duration = 35 + (index * 23) % 125
        completed = started + timedelta(minutes=duration)
        availability[machine["id"]] = completed + timedelta(minutes=15)
        availability[executor["id"]] = completed + timedelta(minutes=15)
        issued = started - timedelta(hours=2 + index % 5)
        priority = ("emergency", "high", "normal", "planned")[index % 4]
        deadline = started + timedelta(
            minutes=duration + (20 if priority in {"emergency", "high"} else 90)
        )
        active = index >= 560
        status = (
            "closed"
            if not active
            else (
                "issued",
                "accepted",
                "in_progress",
                "paused",
                "completed",
                "ai_review",
                "rework",
            )[index % 7]
        )
        if active and deadline >= datetime.combine(anchor, datetime.min.time(), UTC):
            deadline = datetime.combine(anchor, datetime.min.time(), UTC) - timedelta(
                hours=1 + index % 8
            )
        item = _row(
            id=ident("order", number),
            number=number,
            work_type=work_type,
            description=f"{_DEMO}{fault_code['name']} на {machine['name']}",
            area_id=machine["area_id"],
            equipment_id=machine["id"],
            executor_id=executor["id"],
            master_id=master["id"],
            priority=priority,
            status=status,
            issued_at=issued,
            deadline=deadline,
            started_at=started
            if status not in {"issued", "accepted", "queued", "rejected"}
            else None,
            completed_at=completed
            if status in {"closed", "completed", "ai_review", "rework"}
            else None,
            closed_at=completed + timedelta(minutes=20) if status == "closed" else None,
            fault_code_id=fault_code["id"],
            work_description=f"{_DEMO}выполнена проверка и ремонт узла",
            comment=f"{_DEMO}фото намеренно не созданы: хранилище будет добавлено на этапе 3.",
            version=1,
            is_synthetic=True,
        )
        orders.append(item)
        _events_for_order(events, ident, item, executor, master, completed, status)
        if status in {"closed", "ai_review", "rework"}:
            needs_review = status == "ai_review" and index % 3 == 0
            verdict: str | None
            if status == "rework":
                verdict = "rework_required"
            elif needs_review:
                verdict = None
            else:
                verdict = "accepted_with_remarks" if index % 6 == 0 else "accepted"
            reviews.append(
                _row(
                    id=ident("review", number),
                    work_order_id=item["id"],
                    order_version=1,
                    verdict=verdict,
                    score=3 if needs_review else 5,
                    needs_master_review=needs_review,
                    explanation=(
                        f"{_DEMO}правиловая фикстура, не результат LLM. Нужна проверка мастером."
                    )
                    if needs_review
                    else f"{_DEMO}правиловая фикстура: данные заполнены.",
                    model_name="synthetic-fixture",
                    created_at=completed + timedelta(minutes=6),
                    master_score=4 if status == "closed" else None,
                )
            )
            if status == "rework":
                rework.append(number)
        material_count = 1 + index % 3
        for part in range(material_count):
            material = materials[(index * 5 + part) % len(materials)]
            quantity = Decimal(1 + ((index + part) % 3))
            if machine["id"] in conveyor_ids and index % 17 == 0 and part == 0:
                quantity = Decimal("14")
                overuse.append(number)
            usages.append(
                _row(
                    id=ident("usage", f"{number}:{part}"),
                    work_order_id=item["id"],
                    material_id=material["id"],
                    quantity=quantity,
                )
            )
        if machine["id"] in conveyor_ids and fault_code["code"].startswith("MECH"):
            hot.append(number)
    patterns = (
        DemoPattern("hot_conveyor", "Повторные механические отказы конвейеров", tuple(hot)),
        DemoPattern(
            "material_overuse", "Повышенный расход материала на конвейерах", tuple(overuse)
        ),
        DemoPattern(
            "post_planned_repeat",
            "Повтор после планового ремонта в течение 7 дней",
            tuple(followup),
        ),
        DemoPattern(
            "executor_rework", "Повышенная доля доработок у одного демо-исполнителя", tuple(rework)
        ),
    )
    return tuple(orders), tuple(events), tuple(usages), tuple(reviews), patterns


def _events_for_order(
    events: list[dict[str, Any]],
    ident: Any,
    order: dict[str, Any],
    executor: dict[str, Any],
    master: dict[str, Any],
    completed: datetime,
    status: str,
) -> int:
    timeline: list[EventStep] = [
        (master, "master", "issue", None, "issued", order["issued_at"], None)
    ]
    if status == "issued":
        return _append_events(events, ident, order, timeline)
    accepted = order["issued_at"] + timedelta(minutes=12)
    timeline.append((executor, "executor", "accept", "issued", "accepted", accepted, None))
    if status == "accepted":
        return _append_events(events, ident, order, timeline)
    timeline.append(
        (executor, "executor", "start", "accepted", "in_progress", order["started_at"], None)
    )
    if status == "in_progress":
        return _append_events(events, ident, order, timeline)
    if status == "paused":
        timeline.append(
            (
                executor,
                "executor",
                "pause",
                "in_progress",
                "paused",
                order["started_at"] + timedelta(minutes=15),
                "ДЕМО: ожидание допуска",
            )
        )
        return _append_events(events, ident, order, timeline)
    timeline.append((executor, "executor", "complete", "in_progress", "completed", completed, None))
    if status == "completed":
        return _append_events(events, ident, order, timeline)
    timeline.append(
        (
            None,
            "system",
            "start_ai_review",
            "completed",
            "ai_review",
            completed + timedelta(minutes=2),
            None,
        )
    )
    if status == "ai_review":
        return _append_events(events, ident, order, timeline)
    if status == "rework":
        timeline.append(
            (
                None,
                "system",
                "mark_rework",
                "ai_review",
                "rework",
                completed + timedelta(minutes=6),
                "ДЕМО: требуется доработка",
            )
        )
        return _append_events(events, ident, order, timeline)
    timeline.append(
        (
            None,
            "system",
            "record_ai_assessment",
            "ai_review",
            "ai_review",
            completed + timedelta(minutes=6),
            None,
        )
    )
    timeline.append(
        (master, "master", "close", "ai_review", "closed", completed + timedelta(minutes=20), None)
    )
    return _append_events(events, ident, order, timeline)


def _append_events(
    events: list[dict[str, Any]],
    ident: Any,
    order: dict[str, Any],
    timeline: list[EventStep],
) -> int:
    for sequence, (actor, role, action, before, after, at, reason) in enumerate(timeline, 1):
        events.append(
            _row(
                id=ident("event", f"{order['number']}:{sequence}"),
                work_order_id=order["id"],
                sequence=sequence,
                actor_id=None if actor is None else actor["id"],
                actor_role=role,
                action=action,
                from_status=before,
                to_status=after,
                occurred_at=at,
                reason=reason,
            )
        )
    return len(timeline)
