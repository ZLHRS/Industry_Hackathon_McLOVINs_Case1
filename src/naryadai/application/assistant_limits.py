"""Bounded process-local budget for user-triggered assistant queries."""

from time import monotonic
from uuid import UUID

from naryadai.application.common import OperationError


class AssistantLimits:
    """Single event loop; multiple API processes require a shared deployment limiter."""

    def __init__(self) -> None:
        self._recent: dict[UUID, list[float]] = {}
        self._active: set[UUID] = set()

    def reserve(self, employee_id: UUID, *, now: float | None = None) -> None:
        at = monotonic() if now is None else now
        self._recent = {
            actor: remaining
            for actor, times in self._recent.items()
            if (remaining := [stamp for stamp in times if stamp > at - 60])
        }
        if employee_id in self._active or len(self._active) >= 2:
            raise OperationError(429, "assistant_busy")
        recent = self._recent.get(employee_id, [])
        if len(recent) >= 6 or (employee_id not in self._recent and len(self._recent) >= 4096):
            raise OperationError(429, "assistant_rate_limited")
        self._recent[employee_id] = [*recent, at]
        self._active.add(employee_id)

    def release(self, employee_id: UUID) -> None:
        self._active.discard(employee_id)
