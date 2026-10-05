"""Event-time reconstruction independent of today's mutable order status."""

from collections import defaultdict
from datetime import datetime
from uuid import UUID

from naryadai.domain.lifecycle import WorkOrderStatus as Status
from naryadai.infrastructure.models import WorkOrder, WorkOrderEvent

Interval = tuple[datetime, datetime]
EventMap = dict[UUID, list[WorkOrderEvent]]
TERMINAL = {Status.CLOSED, Status.CANCELLED, Status.REJECTED}
NOT_OVERDUE = TERMINAL | {Status.COMPLETED, Status.AI_REVIEW}


def within(value: datetime | None, start: datetime, end: datetime) -> bool:
    return value is not None and start <= value < end


def as_uuid(value: object) -> UUID | None:
    try:
        return UUID(str(value)) if value is not None else None
    except ValueError:
        return None


def status_at(order: WorkOrder, events: list[WorkOrderEvent], cutoff: datetime) -> Status:
    status = Status.ISSUED
    for event in events:
        if event.occurred_at >= cutoff:
            break
        status = event.to_status
    if not events:
        # Imported data may have timestamps without a complete event history.
        for value, candidate in (
            (order.started_at, Status.IN_PROGRESS),
            (order.completed_at, Status.COMPLETED),
            (order.closed_at, Status.CLOSED),
        ):
            if value is not None and value < cutoff:
                status = candidate
    return status


def initial_executor(order: WorkOrder, events: list[WorkOrderEvent]) -> UUID:
    for event in events:
        if event.action == "reassign":
            return as_uuid(event.details.get("previous_executor_id")) or order.executor_id
    return order.executor_id


def state_intervals(
    order: WorkOrder,
    events: list[WorkOrderEvent],
    start: datetime,
    end: datetime,
) -> list[tuple[UUID, Status, datetime, datetime]]:
    """Clip active/paused states, preserving the actor before reassignment."""
    output: list[tuple[UUID, Status, datetime, datetime]] = []
    state, mark, actor = Status.ISSUED, order.issued_at, initial_executor(order, events)
    for event in events:
        if event.occurred_at >= end:
            break
        left, right = max(mark, start), min(event.occurred_at, end)
        if state in {Status.IN_PROGRESS, Status.PAUSED} and left < right:
            output.append((actor, state, left, right))
        if event.action == "reassign":
            actor = as_uuid(event.details.get("executor_id")) or order.executor_id
        elif event.actor_role.value == "executor" and event.actor_id is not None:
            actor = event.actor_id
        state, mark = event.to_status, event.occurred_at
    left = max(mark, start)
    if state in {Status.IN_PROGRESS, Status.PAUSED} and left < end:
        output.append((actor, state, left, end))
    return output


def union_seconds(intervals: list[Interval]) -> float:
    merged: list[list[datetime]] = []
    for left, right in sorted(intervals):
        if right <= left:
            continue
        if merged and left <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], right)
        else:
            merged.append([left, right])
    return sum((right - left).total_seconds() for left, right in merged)


def group_events(events: list[WorkOrderEvent]) -> EventMap:
    grouped: EventMap = defaultdict(list)
    for event in events:
        grouped[event.work_order_id].append(event)
    for rows in grouped.values():
        rows.sort(key=lambda e: (e.occurred_at, e.sequence))
    return grouped


def parse_time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.utcoffset() is not None else None
    except ValueError:
        return None
