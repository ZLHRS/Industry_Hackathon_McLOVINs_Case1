import importlib.util
import sys
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from itertools import pairwise
from pathlib import Path

import pytest

from naryadai.demo import generate_demo_dataset
from naryadai.demo.__main__ import main

_SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(_SCRIPTS))
_DEMO_SPEC = importlib.util.spec_from_file_location("demo_script", _SCRIPTS / "demo.py")
assert _DEMO_SPEC is not None and _DEMO_SPEC.loader is not None
_DEMO = importlib.util.module_from_spec(_DEMO_SPEC)
_DEMO_SPEC.loader.exec_module(_DEMO)

ANCHOR = date(2026, 10, 5)


@pytest.fixture(scope="module")
def dataset():
    return generate_demo_dataset(anchor_date=ANCHOR, seed=42)


def test_generator_is_deterministic_for_same_input(dataset) -> None:
    assert generate_demo_dataset(anchor_date=ANCHOR, seed=42) == dataset


def test_seed_changes_identifiers_without_changing_required_volume(dataset) -> None:
    other = generate_demo_dataset(anchor_date=ANCHOR, seed=43)
    assert (
        other.work_orders[0]["id"]
        != generate_demo_dataset(anchor_date=ANCHOR, seed=42).work_orders[0]["id"]
    )
    assert len(other.work_orders) == 600


def test_required_reference_data_and_synthetic_labels_are_present(dataset) -> None:
    assert len(dataset.equipment) == 25
    assert len(dataset.areas) == 4
    assert len(dataset.brigades) == 3
    assert len([item for item in dataset.employees if item["role"] == "master"]) == 2
    assert len([item for item in dataset.employees if item["role"] == "executor"]) == 15
    assert len(dataset.fault_codes) == 20
    assert len(dataset.materials) == 40
    assert all(item["is_synthetic"] is True for item in dataset.work_orders)
    assert all(item["login"].startswith("demo.") for item in dataset.employees)
    manager_id = next(item["id"] for item in dataset.employees if item["role"] == "manager")
    assert {
        item["area_id"] for item in dataset.employee_areas if item["employee_id"] == manager_id
    } == {item["id"] for item in dataset.areas}


def test_history_is_chronological_and_references_known_rows(dataset) -> None:
    known_orders = {item["id"] for item in dataset.work_orders}
    by_order: dict[object, list[dict[object, object]]] = {}
    for event in dataset.events:
        assert event["work_order_id"] in known_orders
        by_order.setdefault(event["work_order_id"], []).append(event)
    for event_list in by_order.values():
        assert [event["sequence"] for event in event_list] == list(range(1, len(event_list) + 1))
        timestamps = [event["occurred_at"] for event in event_list]
        assert timestamps == sorted(timestamps)
        assert all(value.tzinfo == UTC for value in timestamps)


def test_orders_span_three_calendar_months_and_have_realistic_active_statuses(dataset) -> None:
    issued_dates = {item["issued_at"].date().replace(day=1) for item in dataset.work_orders}
    statuses = {item["status"] for item in dataset.work_orders}
    assert len(issued_dates) >= 3
    assert {
        "issued",
        "accepted",
        "in_progress",
        "paused",
        "completed",
        "ai_review",
        "rework",
        "closed",
    } <= statuses
    assert sum(item["status"] == "closed" for item in dataset.work_orders) > 500


def test_material_quantities_are_positive_and_patterns_are_separate_metadata(dataset) -> None:
    assert all(item["quantity"] > Decimal("0") for item in dataset.material_usages)
    patterns = {item.key: item for item in dataset.ground_truth}
    assert set(patterns) == {
        "hot_conveyor",
        "material_overuse",
        "post_planned_repeat",
        "executor_rework",
    }
    order_keys = set(dataset.work_orders[0])
    assert "pattern" not in order_keys
    assert all(pattern.evidence_order_numbers for pattern in patterns.values())


def test_equipment_and_executor_completed_intervals_do_not_overlap(dataset) -> None:
    completed = [item for item in dataset.work_orders if item["completed_at"] is not None]
    for key in ("equipment_id", "executor_id"):
        grouped: dict[object, list[dict[object, object]]] = {}
        for item in completed:
            grouped.setdefault(item[key], []).append(item)
        for values in grouped.values():
            values.sort(key=lambda item: item["started_at"])
            for left, right in pairwise(values):
                assert left["completed_at"] <= right["started_at"]


def test_invalid_generator_arguments_fail_closed() -> None:
    with pytest.raises(TypeError):
        generate_demo_dataset(anchor_date=datetime(2026, 10, 5, tzinfo=UTC), seed=42)
    with pytest.raises(TypeError):
        generate_demo_dataset(anchor_date=ANCHOR, seed=True)


def test_planted_patterns_match_operational_rows(dataset) -> None:
    orders = {item["number"]: item for item in dataset.work_orders}
    patterns = {item.key: item for item in dataset.ground_truth}
    reviews = {item["work_order_id"]: item for item in dataset.ai_reviews}

    for number in patterns["post_planned_repeat"].evidence_order_numbers:
        repeated = orders[number]
        matching = [
            item
            for item in orders.values()
            if item["work_type"] == "planned"
            and item["equipment_id"] == repeated["equipment_id"]
            and item["fault_code_id"] == repeated["fault_code_id"]
            and timedelta(0) <= repeated["issued_at"] - item["issued_at"] <= timedelta(days=7)
        ]
        assert matching

    rework_orders = [
        orders[number] for number in patterns["executor_rework"].evidence_order_numbers
    ]
    assert rework_orders
    assert {item["executor_id"] for item in rework_orders} == {rework_orders[0]["executor_id"]}
    assert all(item["status"] == "rework" for item in rework_orders)
    assert all(reviews[item["id"]]["verdict"] == "rework_required" for item in rework_orders)


def test_cli_rejects_invalid_date_and_missing_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(SystemExit, match="2"):
        main(["--anchor", "05-10-2026"])
    monkeypatch.delenv("NARYADAI_DEMO_SECRET", raising=False)
    with pytest.raises(SystemExit, match="2"):
        main(["--anchor", "2026-10-05"])


def test_demo_rejects_unsupported_platform_before_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_DEMO.sys, "platform", "win32")

    with pytest.raises(_DEMO.PhoneError, match="Linux/WSL or macOS"):
        _DEMO.run(api_port=8000, web_port=5173, seed=False, skip_build=False, worker=False)
