"""Numeric aggregates from events and explicit observations, never proxy downtime."""

from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from itertools import pairwise
from statistics import mean
from uuid import UUID

from naryadai.domain.lifecycle import WorkOrderStatus as Status
from naryadai.infrastructure.models import Material, MaterialUsage, WorkOrder

from .contracts import (
    ActivityEmployeeView,
    ActivityView,
    DowntimeEquipmentView,
    DowntimeView,
    DurationView,
    MaterialBreakdownView,
    MaterialsView,
    MaterialUsageView,
)
from .data import Snapshot
from .history import Interval, parse_time, state_intervals, union_seconds, within


def activity(
    orders: list[WorkOrder], data: Snapshot, start: datetime, end: datetime
) -> ActivityView:
    active: dict[UUID, list[Interval]] = defaultdict(list)
    paused: dict[UUID, list[Interval]] = defaultdict(list)
    touched: dict[UUID, set[UUID]] = defaultdict(set)
    for order in orders:
        for actor, status, left, right in state_intervals(
            order, data.events.get(order.id, []), start, end
        ):
            (active if status == Status.IN_PROGRESS else paused)[actor].append((left, right))
            touched[actor].add(order.id)
    rows = [
        ActivityEmployeeView(
            employee_id=actor,
            employee_name=data.employees[actor].display_name,
            active_seconds=union_seconds(active[actor]),
            paused_seconds=union_seconds(paused[actor]),
            order_count=len(ids),
        )
        for actor, ids in touched.items()
        if actor in data.employees
    ]
    return ActivityView(
        active_order_count=len(set().union(*touched.values())) if touched else 0,
        active_seconds=sum(r.active_seconds for r in rows),
        by_employee=sorted(rows, key=lambda r: (-r.active_seconds, r.employee_name)),
    )


def durations(
    orders: list[WorkOrder], data: Snapshot, start: datetime, end: datetime
) -> DurationView:
    reaction: list[float] = []
    work: list[float] = []
    pauses: list[float] = []
    for order in orders:
        events = data.events.get(order.id, [])
        # A reassignment is a new issuance.  Measure the first response for
        # each assignment instead of silently retaining the previous worker's
        # response as the order's only reaction time.
        response_started_at = order.issued_at
        responded = False
        for event in events:
            if event.action == "reassign":
                response_started_at = event.occurred_at
                responded = False
            elif not responded and event.action in {"accept", "queue", "reject"}:
                if within(event.occurred_at, start, end):
                    elapsed = (event.occurred_at - response_started_at).total_seconds()
                    reaction.append(max(0, elapsed))
                responded = True
        # Compute each submitted attempt separately; no overwritten current-start timestamp.
        last_reset = order.issued_at
        for event in events:
            if event.action == "reassign":
                last_reset = event.occurred_at
            elif event.action == "complete":
                if within(event.occurred_at, start, end):
                    windows = state_intervals(order, events, last_reset, event.occurred_at)
                    work.append(
                        sum(
                            (b - a).total_seconds()
                            for _, s, a, b in windows
                            if s == Status.IN_PROGRESS
                        )
                    )
                    pauses.append(
                        sum((b - a).total_seconds() for _, s, a, b in windows if s == Status.PAUSED)
                    )
                last_reset = event.occurred_at

    def average(values: list[float]) -> float | None:
        return round(mean(values), 3) if values else None

    return DurationView(
        response_seconds=average(reaction),
        work_seconds=average(work),
        pause_seconds=average(pauses),
        sample_sizes={"response": len(reaction), "work": len(work), "pause": len(pauses)},
    )


def recorded_interval(order: WorkOrder, data: Snapshot, now: datetime) -> Interval | None:
    choices = [
        e
        for e in data.events.get(order.id, [])
        if e.action == "record_downtime" and e.occurred_at <= now
    ]
    if not choices:
        return None
    value = max(choices, key=lambda e: (e.occurred_at, e.sequence)).details
    if value.get("void"):
        return None
    left = parse_time(value.get("started_at"))
    right = parse_time(value.get("ended_at")) if value.get("ended_at") is not None else now
    return (left, right) if left and right and left < right else None


def downtime(
    orders: list[WorkOrder], data: Snapshot, start: datetime, end: datetime, now: datetime
) -> DowntimeView:
    windows: dict[UUID, list[tuple[datetime, datetime, str, str, UUID]]] = defaultdict(list)
    unknown: dict[UUID, int] = defaultdict(int)
    for order in orders:
        interval = recorded_interval(order, data, now)
        if interval is None:
            unknown[order.equipment_id] += 1
            continue
        left, right = max(interval[0], start), min(interval[1], end, now)
        if left >= right:
            continue
        fault = data.faults.get(order.fault_code_id) if order.fault_code_id else None
        name = f"{fault.code} · {fault.name}" if fault else "Причина не указана"
        windows[order.equipment_id].append((left, right, order.work_type.value, name, order.id))
    rows: list[DowntimeEquipmentView] = []
    plan = unplan = 0.0
    faults: dict[str, float] = defaultdict(float)
    for eid in sorted(set(windows) | set(unknown), key=str):
        intervals = windows[eid]
        total = union_seconds([(a, b) for a, b, *_ in intervals])
        # Split into non-overlapping segments; an unplanned stop takes precedence.
        boundaries = sorted({time for a, b, *_ in intervals for time in (a, b)})
        for left, right in pairwise(boundaries):
            active = [item for item in intervals if item[0] < right and item[1] > left]
            if not active:
                continue
            seconds = (right - left).total_seconds()
            if any(item[2] == "unplanned" for item in active):
                unplan += seconds
            else:
                plan += seconds
            names = {item[3] for item in active}
            faults[next(iter(names)) if len(names) == 1 else "Несколько причин одновременно"] += (
                seconds
            )
        rows.append(
            DowntimeEquipmentView(
                equipment_id=eid,
                equipment_name=data.equipment[eid].name,
                known_seconds=total,
                unknown_order_count=unknown[eid],
                order_ids=sorted({r[4] for r in intervals}, key=str),
            )
        )
    return DowntimeView(
        known_seconds=sum(r.known_seconds for r in rows),
        planned_seconds=plan,
        unplanned_seconds=unplan,
        by_fault=dict(sorted(faults.items())),
        unknown_order_count=sum(unknown.values()),
        by_equipment=sorted(rows, key=lambda r: (-r.known_seconds, r.equipment_name)),
    )


def material_time(usage: MaterialUsage, order: WorkOrder, data: Snapshot) -> datetime | None:
    if usage.submission_version is None:
        return order.completed_at
    for event in data.events.get(order.id, []):
        if (
            event.action == "complete"
            and (event.details.get("submission_version") or event.order_version)
            == usage.submission_version
        ):
            return event.occurred_at
    return None


def material_actor(usage: MaterialUsage, order: WorkOrder, data: Snapshot) -> UUID:
    for event in data.events.get(order.id, []):
        if (
            event.action == "complete"
            and event.actor_id in data.employees
            and usage.submission_version is not None
            and (event.details.get("submission_version") or event.order_version)
            == usage.submission_version
        ):
            return event.actor_id
    return order.executor_id


def material_rows(
    orders: list[WorkOrder], data: Snapshot, start: datetime, end: datetime
) -> list[tuple[MaterialUsage, Material, WorkOrder]]:
    lookup = {o.id: o for o in orders}
    return [
        (usage, material, lookup[usage.work_order_id])
        for usage, material in data.usages
        if usage.work_order_id in lookup
        and within(material_time(usage, lookup[usage.work_order_id], data), start, end)
    ]


def materials(
    orders: list[WorkOrder], data: Snapshot, start: datetime, end: datetime
) -> MaterialsView:
    rows = material_rows(orders, data, start, end)

    def grouped(dimension: str) -> list[MaterialBreakdownView]:
        buckets: dict[
            tuple[UUID, UUID | None], tuple[Decimal, set[UUID], Material, str | None]
        ] = {}
        for usage, material, order in rows:
            identifier: UUID | None = None
            name: str | None = None
            if dimension == "area":
                identifier, name = order.area_id, data.areas[order.area_id].name
            elif dimension == "equipment":
                identifier, name = order.equipment_id, data.equipment[order.equipment_id].name
            elif dimension == "executor":
                identifier = material_actor(usage, order, data)
                name = data.employees[identifier].display_name
            key = (material.id, identifier)
            quantity, ids, _, _ = buckets.get(key, (Decimal(0), set(), material, name))
            buckets[key] = (quantity + usage.quantity, ids | {order.id}, material, name)
        return [
            MaterialBreakdownView(
                material_id=mid,
                material_name=material.name,
                unit=material.unit,
                quantity=float(quantity),
                order_count=len(ids),
                dimension_id=did,
                dimension_name=name,
            )
            for (mid, did), (quantity, ids, material, name) in sorted(
                buckets.items(), key=lambda item: str(item[0])
            )
        ]

    return MaterialsView(
        usage=[MaterialUsageView.model_validate(row.model_dump()) for row in grouped("")],
        by_area=grouped("area"),
        by_equipment=grouped("equipment"),
        by_executor=grouped("executor"),
    )
