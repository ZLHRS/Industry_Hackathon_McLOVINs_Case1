from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

import pytest
from seeds.industrial.generator import generate_dataset, generate_order_dataset

ALMATY = ZoneInfo("Asia/Almaty")
ANCHOR = datetime(2026, 10, 15, 0, tzinfo=ALMATY)


def test_dataset_is_deterministic_and_ids_do_not_depend_on_anchor_clock() -> None:
    first = generate_dataset(anchor=ANCHOR, seed=2026)
    assert first == generate_dataset(anchor=ANCHOR, seed=2026)
    shifted = generate_dataset(anchor=ANCHOR + timedelta(hours=3), seed=2026)
    for key in (
        "areas",
        "equipment",
        "employees",
        "work_orders",
        "work_order_events",
        "material_usages",
        "ai_reviews",
    ):
        assert [row["id"] for row in first[key]] == [row["id"] for row in shifted[key]]


def test_reference_counts_and_visible_values_are_realistic_without_demo_markers() -> None:
    data = generate_dataset(anchor=ANCHOR)
    assert {
        key: len(data[key])
        for key in ("areas", "brigades", "equipment", "employees", "fault_codes", "materials")
    } == {
        "areas": 4,
        "brigades": 3,
        "equipment": 25,
        "employees": 19,
        "fault_codes": 20,
        "materials": 40,
    }
    visible = " ".join(
        str(value)
        for key in ("areas", "brigades", "equipment", "employees", "fault_codes", "materials")
        for row in data[key]
        for value in row.values()
    )
    assert "demo" not in visible.lower()
    assert "демо" not in visible.lower()
    assert all(row["is_synthetic"] is True for row in data["work_orders"])
    assert not {"photos", "ai_review_jobs", "outbox"} & data.keys()


def test_history_is_coherent_bounded_and_versions_reference_submissions() -> None:
    data = generate_dataset(anchor=ANCHOR)
    orders = {row["id"]: row for row in data["work_orders"]}
    events: dict[object, list[dict[str, object]]] = defaultdict(list)
    for event in data["work_order_events"]:
        events[event["work_order_id"]].append(event)
        assert event["occurred_at"] <= ANCHOR
        assert event["details"]["source"] == "synthetic_industrial_fixture"
    for order_id, rows in events.items():
        assert order_id in orders
        assert [row["sequence"] for row in rows] == list(range(1, len(rows) + 1))
        assert [row["order_version"] for row in rows] == list(range(1, len(rows) + 1))
        assert [row["occurred_at"] for row in rows] == sorted(row["occurred_at"] for row in rows)
        assert orders[order_id]["version"] == rows[-1]["order_version"]
    assert len(data["work_orders"]) == 600
    current = [row for row in data["work_orders"] if row["status"] != "closed"]
    assert len({row["status"] for row in current}) >= 7
    assert any(row["deadline"] > ANCHOR for row in current)
    closed = [row for row in data["work_orders"] if row["status"] == "closed"]
    assert any(row["completed_at"] > row["deadline"] for row in closed)
    assert any(row["completed_at"] <= row["deadline"] for row in closed)
    for order in data["work_orders"]:
        assert order["issued_at"] <= ANCHOR
        assert order["deadline"] >= order["issued_at"]
        if order["started_at"] is not None:
            assert order["issued_at"] <= order["started_at"]
        if order["completed_at"] is not None:
            assert order["started_at"] <= order["completed_at"]
        if order["closed_at"] is not None:
            assert order["completed_at"] <= order["closed_at"]

    completed_versions = {
        (event["work_order_id"], event["order_version"])
        for event in data["work_order_events"]
        if event["action"] == "complete"
    }
    assert all(
        (row["work_order_id"], row["submission_version"]) in completed_versions
        for row in data["material_usages"]
    )
    assert len(data["material_usages"]) == len({row["id"] for row in data["material_usages"]})
    assert len(data["material_usages"]) == len(
        {
            (row["work_order_id"], row["submission_version"], row["material_id"])
            for row in data["material_usages"]
        }
    )
    assert all(
        (row["work_order_id"], row["order_version"]) in completed_versions
        for row in data["ai_reviews"]
    )
    for order in data["work_orders"]:
        submitted = [
            version for work_order_id, version in completed_versions if work_order_id == order["id"]
        ]
        assert order["last_submission_version"] == (max(submitted) if submitted else None)
    assert all(
        row["score"] is None
        and row["verdict"] is None
        and row["model_name"] == "manual-history"
        and row["report"]["source"] == "unavailable"
        and row["report"]["fixture_source"] == "synthetic_industrial_fixture"
        for row in data["ai_reviews"]
    )
    assert all(orders[row["work_order_id"]]["status"] == "closed" for row in data["ai_reviews"])


@pytest.mark.parametrize(
    "anchor",
    (
        ANCHOR,
        datetime(2026, 10, 16, 0, tzinfo=ALMATY),
        datetime(2024, 2, 5, 17, tzinfo=UTC),
    ),
)
@pytest.mark.parametrize("seed", (0, 2026, 2027))
def test_history_window_and_upcoming_demo_orders_are_stable(anchor: datetime, seed: int) -> None:
    data = generate_dataset(anchor=anchor, seed=seed)
    orders = data["work_orders"]
    events = data["work_order_events"]

    def issued_in_window(end: datetime) -> list[dict[str, object]]:
        return [row for row in orders if end - timedelta(days=90) <= row["issued_at"] <= end]

    assert min(row["issued_at"] for row in orders) <= anchor - timedelta(days=90)
    assert len(issued_in_window(anchor)) >= 480
    assert all(row["issued_at"] <= anchor for row in orders)
    assert all(row["completed_at"] is None or row["completed_at"] <= anchor for row in orders)
    assert all(row["closed_at"] is None or row["closed_at"] <= anchor for row in orders)
    assert all(row["occurred_at"] <= anchor for row in events)
    for field in ("equipment_id", "executor_id"):
        intervals: dict[object, list[dict[str, object]]] = defaultdict(list)
        for row in (item for item in orders if item["completed_at"] is not None):
            intervals[row[field]].append(row)
        for history in intervals.values():
            history.sort(key=lambda row: row["started_at"])
            assert all(
                left["completed_at"] <= right["started_at"] for left, right in pairwise(history)
            )

    upcoming = [row for row in orders if row["status"] in {"issued", "accepted", "queued"}]
    assert {row["status"] for row in upcoming} == {"issued", "accepted", "queued"}
    for order in upcoming:
        assert order["deadline"].astimezone(ALMATY).date() == anchor.astimezone(
            ALMATY
        ).date() + timedelta(days=1)
        assert order["priority"] in {"normal", "planned"}
        assert order["started_at"] is None
        assert order["completed_at"] is None
        assert order["closed_at"] is None


def test_assignees_and_materials_match_the_fault_specialty() -> None:
    data = generate_dataset(anchor=ANCHOR)
    orders = {row["id"]: row for row in data["work_orders"]}
    faults = {row["id"]: row for row in data["fault_codes"]}
    employees = {row["id"]: row for row in data["employees"]}
    materials = {row["id"]: row for row in data["materials"]}
    allowed_names = {
        "механик": ("крепёж", "подшипник", "ролик", "лента", "смазка"),
        "электрик": ("кабель", "контактор"),
        "гидравлик": ("масло", "рукав", "фильтр"),
        "универсал": ("крепёж", "подшипник", "ролик", "лента", "смазка"),
    }
    for order in orders.values():
        specialty = faults[order["fault_code_id"]]["specialty"]
        assert employees[order["executor_id"]]["specialty"] == specialty
    for usage in data["material_usages"]:
        order = orders[usage["work_order_id"]]
        specialty = faults[order["fault_code_id"]]["specialty"]
        assert materials[usage["material_id"]]["name"].lower().startswith(allowed_names[specialty])


@pytest.mark.parametrize("seed", (0, 42, 2026, 2027))
def test_current_active_work_never_reuses_an_executor(seed: int) -> None:
    data = generate_dataset(anchor=ANCHOR, seed=seed)
    active = [row for row in data["work_orders"] if row["status"] in {"in_progress", "paused"}]
    assert len({row["executor_id"] for row in active}) == len(active)


def test_completed_equipment_and_executor_intervals_do_not_overlap() -> None:
    data = generate_dataset(anchor=ANCHOR)
    rows = [row for row in data["work_orders"] if row["completed_at"] is not None]
    for field in ("equipment_id", "executor_id"):
        grouped: dict[object, list[dict[str, object]]] = defaultdict(list)
        for row in rows:
            grouped[row[field]].append(row)
        for intervals in grouped.values():
            intervals.sort(key=lambda row: row["started_at"])
            for left, right in pairwise(intervals):
                assert left["completed_at"] <= right["started_at"]


def test_downtime_and_refusal_evidence_are_explicit_events() -> None:
    data = generate_dataset(anchor=ANCHOR)
    events = data["work_order_events"]
    downtime = [row for row in events if row["action"] == "record_downtime"]
    assessments = [row for row in events if row["action"] == "adjudicate_refusal"]
    assert downtime and assessments
    assert all(row["details"]["void"] is False for row in downtime)
    assert all(row["details"]["started_at"] < row["details"]["ended_at"] for row in downtime)
    rejection_ids = {row["id"] for row in events if row["action"] == "reject"}
    assert all(
        row["details"]["rejection_event_id"] in {str(item) for item in rejection_ids}
        for row in assessments
    )
    for event in (row for row in events if row["action"] == "reassign"):
        previous_id = event["details"]["previous_executor_id"]
        assert event["details"]["executor_id"] != previous_id
        preceding_reject = next(
            row
            for row in reversed(events)
            if row["work_order_id"] == event["work_order_id"]
            and row["action"] == "reject"
            and row["sequence"] < event["sequence"]
        )
        assert str(preceding_reject["actor_id"]) == previous_id


def test_conveyor_materials_are_only_used_on_conveyors() -> None:
    data = generate_dataset(anchor=ANCHOR)
    equipment = {row["id"]: row for row in data["equipment"]}
    orders = {row["id"]: row for row in data["work_orders"]}
    materials = {row["id"]: row for row in data["materials"]}
    for usage in data["material_usages"]:
        name = materials[usage["material_id"]]["name"].lower()
        if name.startswith(("лента", "ролик")):
            order = orders[usage["work_order_id"]]
            assert equipment[order["equipment_id"]]["equipment_type"] == "conveyor"


def test_consumed_materials_are_reflected_in_the_completion_report() -> None:
    data = generate_dataset(anchor=ANCHOR)
    orders = {row["id"]: row for row in data["work_orders"]}
    materials = {row["id"]: row for row in data["materials"]}
    report_terms = {
        "ролик": "ролик",
        "лента": "лент",
        "подшипник": "подшипник",
        "смазка": "смазк",
        "крепёж": "болт",
        "контактор": "контактор",
        "кабель": "кабел",
        "рукав": "рукав",
        "фильтр": "фильтр",
        "масло": "масл",
    }
    for usage in data["material_usages"]:
        name = materials[usage["material_id"]]["name"].lower()
        family = next(key for key in report_terms if name.startswith(key))
        report = orders[usage["work_order_id"]]["work_description"]
        assert report is not None
        assert report_terms[family] in report.lower()


def test_terminal_rejection_uses_the_assigned_executor() -> None:
    from uuid import NAMESPACE_URL, uuid5

    from seeds.industrial.generator import _timeline

    data = generate_dataset(anchor=ANCHOR)
    order = data["work_orders"][0] | {"status": "rejected"}
    executor = next(row for row in data["employees"] if row["id"] == order["executor_id"])
    prior = next(
        row
        for row in data["employees"]
        if row["role"] == "executor" and row["id"] != executor["id"]
    )
    master = next(row for row in data["employees"] if row["id"] == order["master_id"])
    events = _timeline(
        order, executor, prior, master, lambda kind, key: uuid5(NAMESPACE_URL, kind + key), 0, False
    )
    assert events[-1]["action"] == "reject"
    assert events[-1]["actor_id"] == order["executor_id"]


def test_history_includes_recent_closed_repairs_for_the_current_reporting_week() -> None:
    data = generate_dataset(anchor=ANCHOR)
    recent = [
        row
        for row in data["work_orders"]
        if row["closed_at"] is not None and row["closed_at"] >= ANCHOR - timedelta(days=4)
    ]
    assert len(recent) >= 4


def test_order_only_generator_uses_existing_catalog_ids_and_fresh_anchor_identity() -> None:
    catalog_data = generate_dataset(anchor=ANCHOR)
    catalog = {
        key: [
            row | {"id": uuid5(NAMESPACE_URL, f"existing:{key}:{row['id']}")}
            for row in catalog_data[key]
        ]
        for key in ("equipment", "fault_codes", "materials", "employees")
    }
    rows = generate_order_dataset(anchor=ANCHOR, seed=2026, catalog=catalog)
    shifted = generate_order_dataset(anchor=ANCHOR + timedelta(days=1), seed=2026, catalog=catalog)
    assert set(rows) == {"work_orders", "work_order_events", "material_usages", "ai_reviews"}
    assert len(rows["work_orders"]) == 600
    assert {row["equipment_id"] for row in rows["work_orders"]} <= {
        row["id"] for row in catalog["equipment"]
    }
    assert {row["executor_id"] for row in rows["work_orders"]} <= {
        row["id"] for row in catalog["employees"]
    }
    assert {row["id"] for row in rows["work_orders"]}.isdisjoint(
        {row["id"] for row in shifted["work_orders"]}
    )


def test_current_snapshot_has_all_actionable_statuses_and_respects_reserved_workers() -> None:
    data = generate_dataset(anchor=ANCHOR)
    catalog = {key: data[key] for key in ("equipment", "fault_codes", "materials", "employees")}
    reserved = {next(row["id"] for row in catalog["employees"] if row["role"] == "executor")}
    rows = generate_order_dataset(anchor=ANCHOR, catalog=catalog, reserved_executor_ids=reserved)
    current = [row for row in rows["work_orders"] if row["status"] != "closed"]
    assert {
        "issued",
        "accepted",
        "queued",
        "in_progress",
        "paused",
        "completed",
        "ai_review",
        "rework",
        "rejected",
    } <= {row["status"] for row in current}
    active = [row for row in current if row["status"] in {"in_progress", "paused"}]
    assert reserved.isdisjoint({row["executor_id"] for row in active})
    assert len({row["executor_id"] for row in active}) == len(active)
    scheduled = [row for row in current if row["status"] in {"issued", "accepted", "queued"}]
    same_shift = [row for row in current if row not in scheduled]
    assert all(
        row["deadline"].astimezone(ALMATY).date() == ANCHOR.date() + timedelta(days=1)
        for row in scheduled
    )
    assert all(
        row["deadline"].astimezone(ALMATY).date() == ANCHOR.date()
        for row in same_shift
        if row["deadline"] >= ANCHOR
    )
    assert all(row["deadline"] <= ANCHOR + timedelta(hours=6) for row in same_shift)
    overdue_paused = [
        row for row in current if row["status"] == "paused" and row["deadline"] < ANCHOR
    ]
    assert len(overdue_paused) == 1
    assert overdue_paused[0]["deadline"] == ANCHOR - timedelta(minutes=30)
    deadline_dates = {row["deadline"].astimezone(ALMATY).date() for row in current}
    assert {ANCHOR.date(), ANCHOR.date() + timedelta(days=1)} <= deadline_dates
    assert sum(row["priority"] == "emergency" for row in rows["work_orders"]) < 60
