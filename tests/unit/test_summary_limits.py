from uuid import uuid4

import pytest

from naryadai.application.common import OperationError
from naryadai.reporting.limits import SummaryLimits


def test_summary_requests_are_bounded_and_cooldown_expires():
    limits = SummaryLimits()
    first, second, third = uuid4(), uuid4(), uuid4()
    limits.reserve(first, now=100)
    with pytest.raises(OperationError, match="summary_cooldown_30_seconds"):
        limits.reserve(first, now=101)
    limits.reserve(second, now=102)
    with pytest.raises(OperationError, match="summary_capacity_reached"):
        limits.reserve(third, now=103)
    limits.release()
    limits.reserve(third, now=104)
    limits.release()
    limits.release()
    limits.reserve(first, now=130)
    limits.release()
