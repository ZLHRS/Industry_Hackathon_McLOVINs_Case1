"""Explainable failure forecast and breakdown timing (case §6.5), not causal predictions."""

# ruff: noqa: RUF001
from collections import Counter, defaultdict
from collections.abc import Iterator
from datetime import datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from naryadai.domain.lifecycle import WorkOrderStatus as Status
from naryadai.infrastructure.models import WorkOrder

from .aggregates import recorded_interval
from .contracts import BreakdownTimeView, FailureForecastView, FailureRiskView
from .data import Snapshot

RECENT_DAYS = 30
HISTORY_DAYS = 90
MIN_BASELINE_DAYS = 60
FORECAST_LIMIT = 5
DOMINANT_FAULT_SHARE = 0.4
# Same boundaries as periods.resolve_period: day 08:00-20:00, night 20:00-08:00.
DAY_SHIFT_HOURS = range(8, 20)

FORECAST_FORMULA = (
    "Внеплановые наряды машины за 30 дней до конца периода против её обычного уровня "
    "за 30 дней в предыдущие 60 дней. Сигнал — не меньше 3 нарядов и минимум вдвое "
    "больше обычного; высокий риск — рост в 3 раза и больше. Шифр называется, если на "
    "него приходится не меньше 40% этих нарядов. Нужна история не короче 90 дней. Это "
    "правило, а не гарантия отказа; фильтры исполнителя и бригады не применяются."
)
TIME_FORMULA = (
    "Внеплановые наряды за 90 дней до конца периода. Время поломки — начало записанного "
    "простоя, если машина встала до выдачи наряда, иначе время выдачи. Дневная смена "
    "08:00–20:00. Связь отмечается от 20 поломок и разницы в 1,5 раза."
)


def _breakdowns(data: Snapshot, start: datetime, end: datetime) -> Iterator[WorkOrder]:
    for order in data.orders:
        if (
            order.work_type.value == "unplanned"
            and order.status != Status.CANCELLED
            and start <= order.issued_at < end
        ):
            yield order


def failure_forecast(data: Snapshot, end: datetime) -> FailureForecastView:
    """Machines whose unplanned orders grew at least twice above their own usual rate."""
    recent_start = end - timedelta(days=RECENT_DAYS)
    history_start = end - timedelta(days=HISTORY_DAYS)
    first_issued = min((order.issued_at for order in data.orders), default=recent_start)
    # A log shorter than 90 days must not turn missing history into "growth".
    baseline_days = max(0, (recent_start - max(history_start, first_issued)).days)
    if baseline_days < MIN_BASELINE_DAYS:
        return FailureForecastView(
            recent_days=RECENT_DAYS, baseline_days=baseline_days, formula=FORECAST_FORMULA
        )
    recent: dict[UUID, list[WorkOrder]] = defaultdict(list)
    earlier: Counter[UUID] = Counter()
    first_observed: dict[UUID, datetime] = {}
    for order in data.orders:
        if order.issued_at >= end:
            continue
        observed_at = first_observed.get(order.equipment_id)
        if observed_at is None or order.issued_at < observed_at:
            first_observed[order.equipment_id] = order.issued_at
    for order in _breakdowns(data, history_start, end):
        if order.issued_at >= recent_start:
            recent[order.equipment_id].append(order)
        else:
            earlier[order.equipment_id] += 1
    items: list[FailureRiskView] = []
    for equipment_id, rows in recent.items():
        machine_first_seen = first_observed.get(equipment_id, recent_start)
        machine_baseline_days = max(0, (recent_start - max(history_start, machine_first_seen)).days)
        if machine_baseline_days < MIN_BASELINE_DAYS:
            continue
        count = len(rows)
        usual = earlier[equipment_id] * RECENT_DAYS / machine_baseline_days
        if count < 3 or count < 2 * usual:
            continue
        growth = count / usual if usual else None
        high = count >= 4 if growth is None else growth >= 3
        # A fault code that explains a real share of the growth, as in the case example
        # (five of seven share one code); a scattered mix names no code.
        faults = Counter(
            order.fault_code_id for order in rows if order.fault_code_id in data.faults
        )
        ranked = sorted(faults.items(), key=lambda item: (-item[1], data.faults[item[0]].code))
        fault_id, fault_count = ranked[0] if ranked else (None, 0)
        dominant = fault_count >= 2 and fault_count >= DOMINANT_FAULT_SHARE * count
        fault = data.faults.get(fault_id) if fault_id and dominant else None
        equipment = data.equipment.get(equipment_id)
        items.append(
            FailureRiskView(
                equipment_id=equipment_id,
                equipment_name=equipment.name if equipment else str(equipment_id),
                recent_count=count,
                usual_count=round(usual, 2),
                growth=None if growth is None else round(growth, 2),
                level="high" if high else "elevated",
                fault_code=fault.code if fault else None,
                fault_name=fault.name if fault else None,
                fault_count=fault_count if fault else 0,
                order_ids=[order.id for order in sorted(rows, key=lambda o: (o.issued_at, o.id))],
            )
        )
    items.sort(
        key=lambda item: (
            item.level != "high",
            -item.recent_count,
            -(item.growth if item.growth is not None else float("inf")),
            item.equipment_name,
        )
    )
    return FailureForecastView(
        recent_days=RECENT_DAYS,
        baseline_days=baseline_days,
        items=items[:FORECAST_LIMIT],
        formula=FORECAST_FORMULA,
    )


def breakdown_time(
    data: Snapshot, end: datetime, now: datetime, timezone: str
) -> BreakdownTimeView:
    """Breakdowns by shift and 6-hour interval of plant time; both shifts last 12 hours."""
    zone = ZoneInfo(timezone)
    buckets = [0, 0, 0, 0]
    day = night = from_downtime = 0
    for order in _breakdowns(data, end - timedelta(days=HISTORY_DAYS), end):
        interval = recorded_interval(order, data, now)
        moment = order.issued_at
        if interval is not None and interval[0] < order.issued_at:
            moment = interval[0]
            from_downtime += 1
        hour = moment.astimezone(zone).hour
        buckets[hour // 6] += 1
        if hour in DAY_SHIFT_HOURS:
            day += 1
        else:
            night += 1
    total, high, low = day + night, max(day, night), min(day, night)
    dominant = total >= 20 and (low == 0 or high / low >= 1.5)
    return BreakdownTimeView(
        days=HISTORY_DAYS,
        timezone=timezone,
        formula=TIME_FORMULA,
        total=total,
        day_shift=day,
        night_shift=night,
        buckets=buckets,
        dominant_shift=("day" if day > night else "night") if dominant else None,
        ratio=round(high / low, 2) if dominant and low else None,
        from_downtime=from_downtime,
    )
