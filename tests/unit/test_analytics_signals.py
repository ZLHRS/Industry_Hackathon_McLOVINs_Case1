from datetime import UTC, datetime
from types import SimpleNamespace as N
from uuid import uuid4

from naryadai.analytics.data import Snapshot
from naryadai.analytics.insights import anomalies
from naryadai.domain.lifecycle import WorkOrderStatus


def T(day):
    return datetime(2026, 6, day, tzinfo=UTC)


START, END = T(1), T(30)


def order(day, *, executor, equipment, fault, completed=None, planned=False):
    return N(
        id=uuid4(),
        issued_at=T(day),
        completed_at=completed or T(day),
        work_type=N(value="planned" if planned else "unplanned"),
        equipment_id=equipment,
        fault_code_id=fault,
        executor_id=executor,
        attempt=1,
    )


def event(oid):
    return N(to_status=WorkOrderStatus.REWORK, occurred_at=T(20))


def snap(rows, events, usages, people, equipment, fault):
    return Snapshot(rows, events, [], usages, people, equipment, {}, {}, {fault.id: fault}, {})


def test_all_detector_families_boundaries_thresholds_and_median_baseline():
    equipment, fault, mat = (
        N(id=uuid4(), name="Pump", equipment_type="pump"),
        N(id=uuid4(), code="F", name="Fault"),
        N(id=uuid4(), name="Seal", unit="pc"),
    )
    hot, peer = uuid4(), uuid4()
    people = {hot: N(display_name="Hot"), peer: N(display_name="Peer")}
    # Exactly seven days is included; a 7d+1h predecessor is not.
    previous = order(1, executor=peer, equipment=equipment.id, fault=fault.id, completed=T(1))
    repeat = order(8, executor=peer, equipment=equipment.id, fault=fault.id)
    ppr = order(
        1, executor=peer, equipment=equipment.id, fault=fault.id, completed=T(1), planned=True
    )
    after_ppr = order(8, executor=peer, equipment=equipment.id, fault=fault.id)
    hot_rows = [
        order(10 + i, executor=hot, equipment=equipment.id, fault=fault.id) for i in range(5)
    ]
    peer_rows = [
        order(16 + i, executor=peer, equipment=equipment.id, fault=fault.id) for i in range(5)
    ]
    rows = [repeat, after_ppr, *hot_rows, *peer_rows]
    usages = []
    events = {hot_rows[0].id: [event(hot_rows[0].id)], hot_rows[1].id: [event(hot_rows[1].id)]}
    for row, quantity in zip(hot_rows, (1, 1, 1, 1, 3), strict=True):
        usage = N(work_order_id=row.id, submission_version=None, quantity=quantity)
        usages.append((usage, mat))
    data = snap([previous, ppr, *rows], events, usages, people, {equipment.id: equipment}, fault)
    signals = anomalies(rows, data, START, END, T(30))
    by = {item.family: item for item in signals}
    assert set(by) == {"recurring_fault", "after_ppr", "rework_concentration", "material_outlier"}
    assert str(previous.id) in by["recurring_fault"].evidence["order_ids"]
    assert str(ppr.id) in by["after_ppr"].evidence["order_ids"]
    assert by["rework_concentration"].evidence["count"] == 2
    assert by["rework_concentration"].evidence["denominator"] == 5
    assert by["material_outlier"].evidence["denominator"] == 5
    assert by["material_outlier"].evidence["baseline_median"] == 1
    assert by["material_outlier"].evidence["order_ids"] == [str(hot_rows[-1].id)]
