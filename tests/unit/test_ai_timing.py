"""Repair timers follow lifecycle changes, not photo/comment audit timestamps."""

from datetime import UTC, datetime, timedelta

import pytest

from naryadai.application.ai_reviews import _timing
from naryadai.domain.lifecycle import WorkOrderStatus as Status
from naryadai.infrastructure.models import WorkOrder, WorkOrderEvent

START = datetime(2026, 10, 11, 8, tzinfo=UTC)


def event(minute, before, after, *, attempt=1):
    return WorkOrderEvent(
        occurred_at=START + timedelta(minutes=minute),
        from_status=before,
        to_status=after,
        details={"attempt": attempt},
    )


@pytest.mark.parametrize("noise_status", [Status.ISSUED, Status.IN_PROGRESS, Status.PAUSED])
def test_non_transition_event_cannot_double_time_or_restore_old_state(noise_status):
    order = WorkOrder(started_at=START, completed_at=START + timedelta(minutes=33), attempt=1)
    events = [
        # Reproduces the live fixture: photo uses wall clock, start uses a past clock.
        event(32, noise_status, noise_status),
        event(0, Status.ACCEPTED, Status.IN_PROGRESS),
        event(33, Status.IN_PROGRESS, Status.COMPLETED),
    ]
    assert _timing(order, events) == (33, 0, 33)


def test_pauses_are_preserved_and_other_attempts_and_late_edits_are_ignored():
    order = WorkOrder(started_at=START, completed_at=START + timedelta(minutes=40), attempt=2)
    events = [
        event(0, Status.REWORK, Status.IN_PROGRESS, attempt=2),
        event(2, Status.IN_PROGRESS, Status.PAUSED, attempt=1),
        event(5, Status.IN_PROGRESS, Status.IN_PROGRESS, attempt=2),
        event(10, Status.IN_PROGRESS, Status.PAUSED, attempt=2),
        event(18, Status.PAUSED, Status.PAUSED, attempt=2),
        event(20, Status.PAUSED, Status.IN_PROGRESS, attempt=2),
        event(40, Status.IN_PROGRESS, Status.COMPLETED, attempt=2),
        event(45, Status.COMPLETED, Status.AI_REVIEW, attempt=2),
    ]
    assert _timing(order, events) == (30, 10, 40)


def test_running_tail_without_completion_event_is_counted():
    order = WorkOrder(started_at=START, completed_at=START + timedelta(minutes=20), attempt=1)
    events = [
        event(0, Status.ACCEPTED, Status.IN_PROGRESS),
        event(5, Status.IN_PROGRESS, Status.PAUSED),
        event(15, Status.PAUSED, Status.IN_PROGRESS),
    ]
    assert _timing(order, events) == (10, 10, 20)
