from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

import pytest
from pydantic import ValidationError

from naryadai.analytics.contracts import AnalyticsQuery, RatingComponent, RatingView
from naryadai.analytics.periods import resolve_period


def test_shift_boundary_is_half_open_and_night_is_anchored_to_requested_date() -> None:
    day = resolve_period(AnalyticsQuery(period="shift", shift="day", date=date(2026, 10, 6)))
    night = resolve_period(AnalyticsQuery(period="shift", shift="night", date=date(2026, 10, 6)))
    assert day.to == night.from_
    assert day.to - day.from_ == timedelta(hours=12)
    assert night.to - night.from_ == timedelta(hours=12)


def test_custom_window_is_bounded_and_requires_aware_timestamps() -> None:
    with pytest.raises(ValidationError):
        AnalyticsQuery(
            period="custom", **{"from": datetime(2026, 1, 1), "to": datetime(2026, 1, 2)}
        )
    with pytest.raises(ValidationError):
        AnalyticsQuery(
            period="custom",
            **{
                "from": datetime(2025, 1, 1, tzinfo=UTC),
                "to": datetime(2026, 1, 3, tzinfo=UTC),
            },
        )


def test_rating_contract_rejects_raw_minutes_and_scores_outside_bounds() -> None:
    with pytest.raises(ValidationError):
        RatingComponent(value=45.0, detail="raw minutes must be represented in numerator/detail")
    with pytest.raises(ValidationError):
        RatingView(
            subject_id=uuid4(),
            subject_name="worker",
            score=101.0,
            components={},
        )
