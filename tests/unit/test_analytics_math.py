"""Independent numeric examples for ratings and calendar boundaries."""

from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace as Obj
from uuid import uuid4

import pytest
from pydantic import ValidationError

from naryadai.analytics.contracts import AnalyticsQuery
from naryadai.analytics.data import Snapshot
from naryadai.analytics.history import parse_time, status_at, union_seconds
from naryadai.analytics.periods import resolve_period
from naryadai.analytics.ratings import build_ratings, latest_score
from naryadai.domain.lifecycle import WorkOrderStatus as Status

START = datetime(2026, 6, 1, tzinfo=UTC)
END = START + timedelta(days=1)
NOW = START + timedelta(days=20)


def sample():
    actor, machine, fault, brigade = (uuid4() for _ in range(4))
    order = Obj(
        id=uuid4(),
        executor_id=actor,
        equipment_id=machine,
        fault_code_id=fault,
        issued_at=START,
        completed_at=START + timedelta(hours=2),
        closed_at=START + timedelta(hours=5),
        deadline=START + timedelta(hours=3),
        attempt=1,
        last_submission_version=4,
        work_type=Obj(value="unplanned"),
    )
    review = Obj(
        id=uuid4(),
        work_order_id=order.id,
        order_version=4,
        created_at=order.completed_at,
        master_score=4,
        score=1,
    )
    snapshot = Snapshot(
        [order],
        {},
        [review],
        [],
        {actor: Obj(display_name="Worker", brigade_id=brigade)},
        {machine: Obj(equipment_type="pump")},
        {},
        {brigade: Obj(name="Crew")},
        {},
        {(fault, "pump"): 1200},
    )
    return order, snapshot


def ratings(order, data, now=NOW):
    return build_ratings([order], data, START, END, now).employees[0]


def test_refusal_correction_replaces_previous_judgment_and_is_attributed_to_actor():
    order, data = sample()
    reject_id = uuid4()
    reject = Obj(
        id=reject_id,
        action="reject",
        actor_id=order.executor_id,
        occurred_at=START + timedelta(hours=1),
        sequence=1,
        details={},
        to_status=Status.REJECTED,
    )
    first = Obj(
        action="adjudicate_refusal",
        actor_id=uuid4(),
        occurred_at=END,
        sequence=2,
        details={"rejection_event_id": str(reject_id), "justified": False},
        to_status=Status.CLOSED,
    )
    data.events[order.id] = [reject, first]
    bad = ratings(order, data)
    assert bad.components["refusal"].value == 0
    assert bad.components["refusal"].numerator == 1
    assert bad.components["refusal"].denominator == 1
    assert bad.score == 87  # .8*40 + 1*25 + 1*20 + 1*10 + 0*5
    correction = Obj(
        action="adjudicate_refusal",
        actor_id=first.actor_id,
        occurred_at=END + timedelta(hours=1),
        sequence=3,
        details={"rejection_event_id": str(reject_id), "justified": True},
        to_status=Status.CLOSED,
    )
    data.events[order.id].append(correction)
    corrected = ratings(order, data)
    assert corrected.components["refusal"].value == 1
    assert corrected.score == 92
    data.events[order.id] = [reject]
    unreviewed = ratings(order, data)
    assert unreviewed.components["refusal"].value is None
    assert unreviewed.score == pytest.approx(87 / 95 * 100, abs=0.01)


def test_repeat_exact_seven_day_window_and_censoring():
    order, data = sample()
    peer = Obj(
        id=uuid4(),
        equipment_id=order.equipment_id,
        fault_code_id=order.fault_code_id,
        work_type=Obj(value="unplanned"),
        issued_at=order.completed_at + timedelta(days=7),
    )
    data.orders.append(peer)
    assert ratings(order, data).components["rework"].value == 0
    peer.issued_at += timedelta(microseconds=1)
    assert ratings(order, data).components["rework"].value == 1
    recent = ratings(order, data, order.completed_at + timedelta(days=6))
    assert recent.components["rework"].value is None
    assert "rework" in recent.unavailable_components
    data.norms.clear()
    assert ratings(order, data).components["volume"].value is None


def test_final_review_link_is_authoritative_and_missing_evidence_stays_unknown():
    order, data = sample()
    accepted = data.reviews[0]
    data.reviews.append(
        Obj(
            id=uuid4(),
            work_order_id=order.id,
            order_version=5,
            created_at=order.completed_at,
            master_score=None,
            score=5,
        )
    )
    data.events[order.id] = [
        Obj(action="close", occurred_at=order.closed_at, details={"review_id": str(accepted.id)})
    ]
    assert latest_score(order, data) == 4
    data.events[order.id][0].details["review_id"] = str(uuid4())
    assert latest_score(order, data) is None
    order.closed_at = None
    assert latest_score(order, data) is None


@pytest.mark.parametrize(
    "kind,day,expected",
    [
        ("week", date(2026, 6, 3), 7),
        ("month", date(2026, 2, 14), 28),
        ("month", date(2026, 12, 31), 31),
    ],
)
def test_calendar_bounds(kind, day, expected):
    period = resolve_period(AnalyticsQuery(period=kind, date=day, timezone="UTC"))
    assert period.to - period.from_ == timedelta(days=expected)
    assert period.from_.weekday() == 0 if kind == "week" else period.from_.day == 1


def test_dst_day_and_imported_history_fallback():
    spring = resolve_period(
        AnalyticsQuery(period="day", date=date(2026, 3, 29), timezone="Europe/Berlin")
    )
    assert spring.to - spring.from_ == timedelta(hours=23)
    fall = resolve_period(
        AnalyticsQuery(period="day", date=date(2026, 10, 25), timezone="Europe/Berlin")
    )
    assert fall.to - fall.from_ == timedelta(hours=25)
    order = Obj(started_at=START, completed_at=END, closed_at=END + timedelta(hours=1))
    assert status_at(order, [], END) == Status.IN_PROGRESS
    assert status_at(order, [], END + timedelta(hours=2)) == Status.CLOSED
    assert union_seconds([(START, END), (START + timedelta(hours=1), END), (END, START)]) == 86400
    assert parse_time("2026-06-01") is None
    assert parse_time("invalid") is None
    assert parse_time(12) is None


@pytest.mark.parametrize(
    "changes",
    [
        {"timezone": "../invalid"},
        {"date": date(1, 1, 1)},
        {"period": "shift", "shift": None},
        {"period": "shift", "shift": "day", "from": START},
        {"shift": "day"},
        {"period": "custom", "date": None},
        {"period": "custom", "from": START, "to": END},
        {
            "period": "custom",
            "date": None,
            "from": datetime(9999, 1, 1, tzinfo=UTC),
            "to": datetime(9999, 2, 1, tzinfo=UTC),
        },
    ],
)
def test_invalid_periods_fail_before_datetime_arithmetic(changes):
    with pytest.raises(ValidationError):
        AnalyticsQuery(**({"period": "day", "date": date(2026, 6, 1)} | changes))
