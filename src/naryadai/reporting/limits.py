"""Small process-local budget guard for explicitly requested AI summaries."""

from time import monotonic
from uuid import UUID

from naryadai.application.common import OperationError


class SummaryLimits:
    """Single-event-loop guard; clustered deployments need a shared rate limiter."""

    def __init__(self) -> None:
        self._recent: dict[UUID, float] = {}
        self._active = 0

    def reserve(self, employee_id: UUID, *, now: float | None = None) -> None:
        at = monotonic() if now is None else now
        self._recent = {key: expiry for key, expiry in self._recent.items() if expiry > at}
        if employee_id in self._recent:
            raise OperationError(429, "summary_cooldown_30_seconds")
        if self._active >= 2 or len(self._recent) >= 4096:
            raise OperationError(429, "summary_capacity_reached")
        self._active += 1
        self._recent[employee_id] = at + 30

    def release(self) -> None:
        self._active = max(0, self._active - 1)
