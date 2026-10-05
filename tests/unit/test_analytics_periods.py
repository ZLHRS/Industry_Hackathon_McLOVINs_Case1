from datetime import UTC, date, datetime

import pytest
from pydantic import ValidationError

from naryadai.analytics.contracts import AnalyticsQuery
from naryadai.analytics.periods import resolve_period


def test_day_and_night_shifts_are_half_open_in_qostanay():
    day = resolve_period(AnalyticsQuery(period="shift", shift="day", date=date(2026, 10, 6)))
    night = resolve_period(AnalyticsQuery(period="shift", shift="night", date=date(2026, 10, 6)))
    assert day.to == night.from_
    assert (day.to - day.from_).total_seconds() == 12 * 3600
    assert (night.to - night.from_).total_seconds() == 12 * 3600


def test_custom_period_rejects_more_than_366_days():
    with pytest.raises(ValidationError, match="custom_range_exceeds_366_days"):
        AnalyticsQuery(
            period="custom",
            **{"from": datetime(2025, 1, 1, tzinfo=UTC), "to": datetime(2026, 1, 3, tzinfo=UTC)},
        )


def test_calendar_period_requires_date():
    with pytest.raises(ValidationError, match="calendar_period_requires_date"):
        AnalyticsQuery(period="day")
