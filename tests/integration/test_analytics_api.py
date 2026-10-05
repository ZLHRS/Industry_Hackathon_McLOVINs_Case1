from datetime import date
from uuid import uuid4

import pytest

from naryadai.api.analytics import analytics_query


@pytest.mark.asyncio
async def test_analytics_query_accepts_comma_separated_filter_ids():
    first, second = uuid4(), uuid4()
    query = await analytics_query(
        period="day",
        shift=None,
        date=date.today().isoformat(),
        from_=None,
        to=None,
        timezone="Asia/Qostanay",
        area_id=[f"{first},{second}"],
        equipment_id=[],
        executor_id=[],
        brigade_id=[],
    )
    assert query.area_ids == (first, second)
