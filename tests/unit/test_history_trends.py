"""History-based equipment signals remain explainable and safely scoped."""

from datetime import UTC, datetime
from io import BytesIO
from types import SimpleNamespace as Obj
from uuid import UUID, uuid4
from zipfile import ZipFile
from zoneinfo import ZoneInfo

from naryadai.analytics.contracts import (
    AnalyticsReport,
    BreakdownTimeView,
    FailureForecastView,
    FailureRiskView,
    FilterView,
    MetaView,
    PeriodView,
    ScopeView,
)
from naryadai.analytics.data import Snapshot
from naryadai.analytics.trends import breakdown_time, failure_forecast
from naryadai.domain.lifecycle import WorkOrderStatus as Status
from naryadai.reporting.analytics_report import export_analytics

END = datetime(2026, 4, 1, tzinfo=UTC)


def _order(
    issued_at: datetime,
    equipment_id: UUID,
    *,
    fault_code_id: UUID | None = None,
    status: Status = Status.CLOSED,
    work_type: str = "unplanned",
) -> Obj:
    return Obj(
        id=uuid4(),
        equipment_id=equipment_id,
        fault_code_id=fault_code_id,
        issued_at=issued_at,
        work_type=Obj(value=work_type),
        status=status,
    )


def _snapshot(
    orders: list[Obj], events: dict[UUID, list[Obj]] | None = None, fault: UUID | None = None
) -> Snapshot:
    equipment = {
        row.equipment_id: Obj(name=f"Machine {index}", equipment_type="pump")
        for index, row in enumerate(orders)
    }
    faults = {fault: Obj(code="F-1", name="Seal failure")} if fault else {}
    return Snapshot(orders, events or {}, [], [], {}, equipment, {}, {}, faults, {})


def test_failure_forecast_uses_the_previous_sixty_days_as_a_monthly_baseline() -> None:
    machine, fault = uuid4(), uuid4()
    earlier = [
        _order(datetime(2026, 1, day, tzinfo=UTC), machine, fault_code_id=fault)
        for day in (1, 10, 20)
    ]
    recent = [
        _order(datetime(2026, 3, day, tzinfo=UTC), machine, fault_code_id=fault)
        for day in (3, 8, 15)
    ]
    excluded = [
        _order(
            datetime(2026, 3, 16, tzinfo=UTC),
            machine,
            fault_code_id=fault,
            work_type="planned",
        ),
        _order(
            datetime(2026, 3, 17, tzinfo=UTC),
            machine,
            fault_code_id=fault,
            status=Status.CANCELLED,
        ),
    ]

    forecast = failure_forecast(_snapshot([*earlier, *recent, *excluded], fault=fault), END)

    assert forecast.baseline_days == 60
    assert "90" in forecast.formula
    assert len(forecast.items) == 1
    signal = forecast.items[0]
    assert (signal.recent_count, signal.usual_count, signal.growth, signal.level) == (
        3,
        1.5,
        2.0,
        "elevated",
    )
    assert (signal.fault_code, signal.fault_count) == ("F-1", 3)
    assert signal.order_ids == [row.id for row in recent]


def test_failure_forecast_requires_a_complete_prior_sixty_day_history() -> None:
    machine = uuid4()
    rows = [_order(datetime(2026, 2, 1, tzinfo=UTC), machine)]
    rows.extend(_order(datetime(2026, 3, day, tzinfo=UTC), machine) for day in (3, 8, 15))

    forecast = failure_forecast(_snapshot(rows), END)

    assert forecast.baseline_days == 29
    assert forecast.items == []


def test_failure_forecast_requires_history_for_each_machine() -> None:
    established, new_machine = uuid4(), uuid4()
    old_area_history = [_order(datetime(2026, 1, 1, tzinfo=UTC), established, work_type="planned")]
    new_breakdowns = [_order(datetime(2026, 3, day, tzinfo=UTC), new_machine) for day in (3, 8, 15)]

    without_machine_history = failure_forecast(_snapshot([*old_area_history, *new_breakdowns]), END)
    assert without_machine_history.baseline_days == 60
    assert without_machine_history.items == []

    established_machine_history = _order(
        datetime(2026, 1, 1, tzinfo=UTC), new_machine, work_type="planned"
    )
    with_machine_history = failure_forecast(
        _snapshot([*old_area_history, established_machine_history, *new_breakdowns]), END
    )
    assert len(with_machine_history.items) == 1
    assert with_machine_history.items[0].equipment_id == new_machine
    assert with_machine_history.items[0].usual_count == 0


def _local(day: int, hour: int) -> datetime:
    return datetime(2026, 3, day, hour, tzinfo=ZoneInfo("Asia/Qostanay")).astimezone(UTC)


def test_breakdown_time_uses_qostanay_shifts_recorded_stop_and_minimum_evidence() -> None:
    machine = uuid4()
    day_rows = [
        _order(_local(10, 21) if index == 0 else _local(10, 10), machine) for index in range(12)
    ]
    night_rows = [_order(_local(11, 21), machine) for _ in range(8)]
    recorded = Obj(
        action="record_downtime",
        occurred_at=_local(10, 22),
        sequence=1,
        details={"started_at": _local(10, 10).isoformat(), "ended_at": _local(10, 11).isoformat()},
    )
    result = breakdown_time(
        _snapshot([*day_rows, *night_rows], {day_rows[0].id: [recorded]}),
        END,
        END,
        "Asia/Qostanay",
    )

    assert (result.total, result.day_shift, result.night_shift) == (20, 12, 8)
    assert (result.dominant_shift, result.ratio, result.from_downtime) == ("day", 1.5, 1)

    insufficient = breakdown_time(
        _snapshot([*day_rows, *night_rows[:-1]]), END, END, "Asia/Qostanay"
    )
    assert insufficient.total == 19
    assert insufficient.dominant_shift is None
    assert insufficient.ratio is None


def test_export_includes_aggregate_history_sheets_without_order_identifiers() -> None:
    private_order_id = uuid4()
    report = AnalyticsReport(
        period=PeriodView(kind="day", timezone="Asia/Qostanay", from_=END, to=END, label="private"),
        filters=FilterView(),
        scope=ScopeView(role="master"),
        orders={},
        durations={},
        activity={},
        downtime={},
        ratings={},
        materials={},
        leaders={},
        forecast=FailureForecastView(
            recent_days=30,
            baseline_days=60,
            formula="aggregate rule",
            items=[
                FailureRiskView(
                    equipment_id=uuid4(),
                    equipment_name="Pump 1",
                    recent_count=3,
                    usual_count=1.5,
                    growth=2,
                    level="elevated",
                    order_ids=[private_order_id],
                )
            ],
        ),
        breakdown_time=BreakdownTimeView(
            days=90,
            timezone="Asia/Qostanay",
            formula="aggregate timing rule",
            total=20,
            day_shift=12,
            night_shift=8,
        ),
        meta=MetaView(as_of=END, row_count=20),
    )

    with ZipFile(BytesIO(export_analytics(report))) as archive:
        workbook = archive.read("xl/workbook.xml")
        text = b"".join(archive.read(name) for name in archive.namelist() if name.endswith(".xml"))

    assert "Прогноз отказов".encode() in workbook
    assert "Поломки по сменам".encode() in workbook
    assert str(private_order_id).encode() not in text
