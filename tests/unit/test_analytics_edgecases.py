"""Independent event histories for analytics boundary and attribution checks."""

from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace as Obj
from uuid import UUID, uuid4

from naryadai.analytics.aggregates import durations, materials
from naryadai.analytics.data import Snapshot
from naryadai.analytics.insights import anomalies
from naryadai.analytics.ratings import build_ratings
from naryadai.domain.lifecycle import WorkOrderStatus as Status


def at(hour: int, day: int = 1) -> datetime:
    return datetime(2026, 6, day, hour, tzinfo=UTC)


def _order(executor: UUID, *, attempt: int = 1, number: str = "O") -> Obj:
    return Obj(
        id=uuid4(),
        number=number,
        executor_id=executor,
        equipment_id=EQUIPMENT,
        area_id=AREA,
        fault_code_id=None,
        issued_at=at(8),
        started_at=at(8),
        completed_at=at(10),
        closed_at=at(11),
        deadline=at(12),
        attempt=attempt,
        last_submission_version=None,
        work_type=Obj(value="unplanned"),
    )


AREA, EQUIPMENT = uuid4(), uuid4()


def _snapshot(
    orders: list[Obj], events: dict[UUID, list[Obj]], people: dict[UUID, Obj]
) -> Snapshot:
    return Snapshot(
        orders,
        events,
        [],
        [],
        people,
        {EQUIPMENT: Obj(name="Pump", equipment_type="pump", area_id=AREA)},
        {AREA: Obj(name="Area")},
        {},
        {},
        {},
    )


def test_imported_attempt_counter_does_not_assign_personal_rework_without_history() -> None:
    returned, peer = uuid4(), uuid4()
    returned_rows = [_order(returned, attempt=2, number=f"R{index}") for index in range(5)]
    peer_rows = [_order(peer, number=f"P{index}") for index in range(5)]
    data = _snapshot(
        [*returned_rows, *peer_rows],
        {},
        {
            returned: Obj(display_name="Returned", brigade_id=None),
            peer: Obj(display_name="Peer", brigade_id=None),
        },
    )
    ratings = build_ratings(
        data.orders,
        data,
        at(0),
        at(0, day=2),
        at(0, day=20),
    )
    returned_rating = next(row for row in ratings.employees if row.subject_id == returned)
    assert returned_rating.components["rework"].numerator == 0
    assert returned_rating.components["rework"].denominator == 0
    assert returned_rating.components["rework"].value is None
    assert any("не влияют на персональный показатель" in item for item in ratings.limitations)
    concentration = [
        item
        for item in anomalies(data.orders, data, at(0), at(0, day=2), at(0, day=20))
        if item.family == "rework_concentration"
    ]
    assert concentration == []


def test_reassignment_starts_a_new_reaction_measurement_and_keeps_half_open_boundary() -> None:
    first, replacement, master = uuid4(), uuid4(), uuid4()
    order = _order(replacement)
    events = [
        Obj(action="accept", actor_id=first, occurred_at=at(9), to_status=Status.ACCEPTED),
        Obj(action="reassign", actor_id=master, occurred_at=at(10), to_status=Status.ISSUED),
        Obj(action="accept", actor_id=replacement, occurred_at=at(11), to_status=Status.ACCEPTED),
        Obj(action="reassign", actor_id=master, occurred_at=at(12), to_status=Status.ISSUED),
        Obj(
            action="accept",
            actor_id=replacement,
            occurred_at=at(0, day=2),
            to_status=Status.ACCEPTED,
        ),
    ]
    data = _snapshot(
        [order],
        {order.id: events},
        {
            first: Obj(display_name="First", brigade_id=None),
            replacement: Obj(display_name="Replacement", brigade_id=None),
        },
    )
    result = durations([order], data, at(8), at(0, day=2))
    assert result.sample_sizes["response"] == 2
    assert result.response_seconds == 3600


def test_material_versions_follow_the_executor_who_submitted_each_version() -> None:
    first, replacement, master, material_id = (uuid4() for _ in range(4))
    order = _order(replacement)
    first_version, replacement_version = 3, 7
    material = Obj(id=material_id, name="Seal", unit="pc")
    events = [
        Obj(
            action="complete",
            actor_id=first,
            occurred_at=at(10),
            details={"submission_version": first_version},
            order_version=first_version,
            to_status=Status.COMPLETED,
        ),
        Obj(action="reassign", actor_id=master, occurred_at=at(12), details={}, order_version=4),
        Obj(
            action="complete",
            actor_id=replacement,
            occurred_at=at(10, day=2),
            details={"submission_version": replacement_version},
            order_version=replacement_version,
            to_status=Status.COMPLETED,
        ),
    ]
    data = _snapshot(
        [order],
        {order.id: events},
        {
            first: Obj(display_name="First", brigade_id=None),
            replacement: Obj(display_name="Replacement", brigade_id=None),
        },
    )
    data.usages.extend(
        [
            (
                Obj(
                    work_order_id=order.id,
                    material_id=material_id,
                    quantity=Decimal("2"),
                    submission_version=3,
                ),
                material,
            ),
            (
                Obj(
                    work_order_id=order.id,
                    material_id=material_id,
                    quantity=Decimal("5"),
                    submission_version=7,
                ),
                material,
            ),
        ]
    )
    first_day = materials([order], data, at(0), at(0, day=2))
    second_day = materials([order], data, at(0, day=2), at(0, day=3))
    assert [(row.dimension_id, row.quantity) for row in first_day.by_executor] == [(first, 2.0)]
    assert [(row.dimension_id, row.quantity) for row in second_day.by_executor] == [
        (replacement, 5.0)
    ]
