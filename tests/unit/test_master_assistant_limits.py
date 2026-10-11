"""Assistant throttling must release capacity without losing request budgets."""

from uuid import uuid4

import pytest

from naryadai.application.assistant_limits import AssistantLimits
from naryadai.application.common import OperationError


def test_assistant_capacity_actor_isolation_and_release():
    limits = AssistantLimits()
    first, second, third = uuid4(), uuid4(), uuid4()
    limits.reserve(first, now=1)
    with pytest.raises(OperationError, match="assistant_busy"):
        limits.reserve(first, now=2)
    limits.reserve(second, now=2)
    with pytest.raises(OperationError, match="assistant_busy"):
        limits.reserve(third, now=3)
    limits.release(first)
    limits.release(first)
    limits.reserve(third, now=4)
    with pytest.raises(OperationError, match="assistant_busy"):
        limits.reserve(first, now=4)


def test_assistant_sliding_budget_expires_after_sixty_seconds():
    limits = AssistantLimits()
    actor = uuid4()
    for stamp in range(6):
        limits.reserve(actor, now=stamp)
        limits.release(actor)
    with pytest.raises(OperationError, match="assistant_rate_limited"):
        limits.reserve(actor, now=59)
    limits.reserve(actor, now=60)
    limits.release(actor)
    with pytest.raises(OperationError, match="assistant_rate_limited"):
        limits.reserve(actor, now=60.5)
