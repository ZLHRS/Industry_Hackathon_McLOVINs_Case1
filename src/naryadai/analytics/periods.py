"""Timezone-safe half-open reporting period helpers."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from .contracts import AnalyticsQuery, PeriodView


def resolve_period(query: AnalyticsQuery) -> PeriodView:
    zone = ZoneInfo(query.timezone)
    if query.period == "custom":
        assert query.from_ is not None and query.to is not None
        start, end = query.from_.astimezone(UTC), query.to.astimezone(UTC)
        return PeriodView(
            kind="custom",
            timezone=query.timezone,
            from_=start,
            to=end,
            label=f"{start.isoformat()} — {end.isoformat()}",
        )
    assert query.date is not None
    if query.period == "shift":
        assert query.shift is not None
        start_local = datetime.combine(query.date, time(8 if query.shift == "day" else 20), zone)
        return PeriodView(
            kind="shift",
            shift=query.shift,
            timezone=query.timezone,
            from_=start_local.astimezone(UTC),
            to=(start_local + timedelta(hours=12)).astimezone(UTC),
            label=f"{query.date.isoformat()} · "
            + ("Дневная смена" if query.shift == "day" else "Ночная смена"),
        )
    if query.period == "day":
        start_local, end_local = (
            datetime.combine(query.date, time.min, zone),
            datetime.combine(query.date + timedelta(days=1), time.min, zone),
        )
    elif query.period == "week":
        start_local = datetime.combine(
            query.date - timedelta(days=query.date.weekday()), time.min, zone
        )
        end_local = start_local + timedelta(days=7)
    else:
        start_local = datetime.combine(query.date.replace(day=1), time.min, zone)
        end_local = datetime.combine(
            (start_local + timedelta(days=32)).replace(day=1), time.min, zone
        )
    return PeriodView(
        kind=query.period,
        timezone=query.timezone,
        from_=start_local.astimezone(UTC),
        to=end_local.astimezone(UTC),
        label=start_local.date().isoformat(),
    )
