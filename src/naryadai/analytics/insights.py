"""Deterministic review signals with disclosed denominators, not causal predictions."""

# ruff: noqa: RUF001
from bisect import bisect_left
from collections import defaultdict
from datetime import datetime, timedelta
from statistics import median
from uuid import UUID

from naryadai.infrastructure.models import WorkOrder

from .aggregates import material_rows
from .contracts import AnomalyView
from .data import Snapshot
from .history import within
from .ratings import final_submission_actor, rework_actors


def anomalies(
    orders: list[WorkOrder], data: Snapshot, start: datetime, end: datetime, now: datetime
) -> list[AnomalyView]:
    output: list[AnomalyView] = []
    unplanned: dict[tuple[UUID, UUID], list[WorkOrder]] = defaultdict(list)
    planned: dict[UUID, list[WorkOrder]] = defaultdict(list)
    for order in data.orders:
        if order.completed_at and order.completed_at <= now:
            if order.work_type.value == "planned":
                planned[order.equipment_id].append(order)
            elif order.fault_code_id:
                unplanned[(order.equipment_id, order.fault_code_id)].append(order)
    for rows in [*unplanned.values(), *planned.values()]:
        rows.sort(key=lambda o: (o.completed_at or now, str(o.id)))
    recurrences: dict[tuple[UUID, UUID], set[UUID]] = defaultdict(set)
    ppr_hits: dict[UUID, set[UUID]] = defaultdict(set)
    for order in orders:
        if order.work_type.value != "unplanned" or not within(order.issued_at, start, end):
            continue
        for family, rows in (
            (
                "repeat",
                unplanned.get((order.equipment_id, order.fault_code_id), [])
                if order.fault_code_id
                else [],
            ),
            ("ppr", planned.get(order.equipment_id, [])),
        ):
            index = bisect_left([o.completed_at or now for o in rows], order.issued_at) - 1
            if index >= 0:
                previous = rows[index]
                if previous.completed_at and order.issued_at - previous.completed_at <= timedelta(
                    days=7
                ):
                    if family == "repeat" and order.fault_code_id:
                        recurrences[(order.equipment_id, order.fault_code_id)].update(
                            (previous.id, order.id)
                        )
                    else:
                        ppr_hits[order.equipment_id].update((previous.id, order.id))
    for (eid, fid), ids in sorted(recurrences.items(), key=lambda r: str(r[0])):
        name = data.equipment[eid].name
        fault = data.faults.get(fid)
        denominator = sum(
            o.equipment_id == eid and o.fault_code_id == fid and within(o.issued_at, start, end)
            for o in orders
        )
        output.append(
            AnomalyView(
                family="recurring_fault",
                severity="high" if len(ids) >= 4 else "medium",
                title=(
                    f"{name}: повторяется "
                    f"{fault.code if fault else 'одна неисправность'}. Проверьте причину "
                    f"повторного ремонта."
                ),
                evidence={
                    "order_ids": sorted(map(str, ids)),
                    "count": len(ids),
                    "denominator": denominator,
                    "equipment_id": str(eid),
                },
                formula=(
                    "Тот же шифр и оборудование; новый внеплановый наряд в течение 7 "
                    "дней после выполнения предыдущего. Число — связанные наряды, "
                    "включая контекст."
                ),
            )
        )
    for eid, ids in sorted(ppr_hits.items(), key=lambda r: str(r[0])):
        output.append(
            AnomalyView(
                family="after_ppr",
                severity="medium",
                title=(
                    f"{data.equipment[eid].name}: внеплановые работы после ППР. Проверьте "
                    f"объём и результаты планового ремонта."
                ),
                evidence={
                    "order_ids": sorted(map(str, ids)),
                    "count": len(ids),
                    "denominator": len(planned[eid]),
                    "equipment_id": str(eid),
                },
                formula=(
                    "Новый внеплановый наряд через 0–7 дней после выполненного ППР; "
                    "связь по времени не доказывает причину."
                ),
            )
        )
    # Each row is one attributable order outcome for a worker.  A returned
    # submission remains with its author even when a reassigned executor later
    # supplies the final closure.
    cohort: list[tuple[WorkOrder, UUID, bool]] = []
    for order in orders:
        if not within(order.completed_at, start, end):
            continue
        events = data.events.get(order.id, [])
        if not events and order.attempt > 1:
            # The aggregate attempt counter cannot establish which worker's
            # submission was returned, so it cannot establish a cohort outcome.
            continue
        rework_actor_set = rework_actors(order, events, now)
        actor = final_submission_actor(order, data)
        if actor is not None:
            cohort.append((order, actor, actor in rework_actor_set))
        for rework_actor in rework_actor_set - ({actor} if actor is not None else set()):
            cohort.append((order, rework_actor, True))
    grouped: dict[UUID, list[tuple[WorkOrder, bool]]] = defaultdict(list)
    for cohort_order, cohort_actor, cohort_reworked in cohort:
        grouped[cohort_actor].append((cohort_order, cohort_reworked))
    overall = (
        sum(cohort_reworked for _, _, cohort_reworked in cohort) / len(cohort) if cohort else 0
    )
    for person, person_rows in sorted(grouped.items(), key=lambda r: str(r[0])):
        failed = [order for order, reworked in person_rows if reworked]
        rate = len(failed) / len(person_rows)
        if len(person_rows) >= 5 and len(failed) >= 2 and rate >= 2 * overall:
            output.append(
                AnomalyView(
                    family="rework_concentration",
                    severity="medium",
                    title=(
                        f"{data.employees[person].display_name}: повышена доля доработок. "
                        f"Разберите причины и сложность заданий."
                    ),
                    evidence={
                        "order_ids": [str(o.id) for o in failed],
                        "count": len(failed),
                        "denominator": len(person_rows),
                        "rate": round(rate, 4),
                        "baseline_rate": round(overall, 4),
                        "executor_id": str(person),
                    },
                    formula=(
                        "Не менее 5 сдававшихся нарядов и 2 доработок; доля доработок "
                        "минимум вдвое выше общей в выборке. Сдача до переназначения "
                        "относится к её автору. Это не оценка вины."
                    ),
                )
            )
    observations: dict[tuple[UUID, str], dict[UUID, float]] = defaultdict(
        lambda: defaultdict(float)
    )
    names: dict[UUID, str] = {}
    for usage, material, order in material_rows(orders, data, start, end):
        observations[(material.id, data.equipment[order.equipment_id].equipment_type)][
            order.id
        ] += float(usage.quantity)
        names[material.id] = f"{material.name}, {material.unit}"
    for (mid, kind), values in sorted(observations.items(), key=lambda r: str(r[0])):
        if len(values) < 5:
            continue
        typical = median(values.values())
        outliers = [
            oid for oid, quantity in values.items() if typical > 0 and quantity >= 3 * typical
        ]
        if outliers:
            output.append(
                AnomalyView(
                    family="material_outlier",
                    severity="medium",
                    title=(
                        f"{names[mid]}: расход выше типичного для типа «{kind}». "
                        f"Проверьте списание и различия в работах."
                    ),
                    evidence={
                        "order_ids": sorted(map(str, outliers)),
                        "count": len(outliers),
                        "denominator": len(values),
                        "baseline_median": typical,
                        "material_id": str(mid),
                    },
                    formula=(
                        "Один материал и тип оборудования, минимум 5 нарядов: суммарный "
                        "расход на наряд ≥3 медиан. Это статистический сигнал, не "
                        "утверждённая норма."
                    ),
                )
            )
    return sorted(output, key=lambda x: (x.family, x.title))
