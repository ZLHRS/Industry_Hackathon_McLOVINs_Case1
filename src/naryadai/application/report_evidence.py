"""Append-only master observations used by reports; never infer employee fault."""

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select

from naryadai.application.common import (
    OperationError,
    check_version,
    ensure_role,
    get_order,
    idempotent,
    mutation_result,
    record_event,
    remember,
    require_master_owner,
)
from naryadai.auth.dependencies import Principal
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import WorkOrderEvent


class DowntimeRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)
    expected_version: int = Field(ge=1)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    reason: str = Field(min_length=3, max_length=1000)
    void: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def validate_interval(self) -> "DowntimeRecord":
        if self.void:
            if self.started_at is not None or self.ended_at is not None:
                raise ValueError("void_requires_no_interval")
            return self
        if self.started_at is None:
            raise ValueError("started_at_required")
        for value in (self.started_at, self.ended_at):
            if value is not None and (value.tzinfo is None or value.utcoffset() is None):
                raise ValueError("downtime_timestamp_must_be_timezone_aware")
        if self.ended_at is not None and (
            self.ended_at <= self.started_at
            or self.ended_at - self.started_at > timedelta(days=366)
        ):
            raise ValueError("invalid_downtime_interval")
        return self


class RefusalAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)
    expected_version: int = Field(ge=1)
    justified: bool = Field(strict=True)
    reason: str = Field(min_length=3, max_length=1000)


async def save_report_evidence(
    database: Database,
    principal: Principal,
    order_id: UUID,
    body: DowntimeRecord | RefusalAssessment,
    key: str,
    *,
    rejection_event_id: UUID | None = None,
) -> dict[str, Any]:
    ensure_role(principal, "master")
    action = "record_downtime" if isinstance(body, DowntimeRecord) else "adjudicate_refusal"
    payload = {"order_id": str(order_id), **body.model_dump(mode="json")}
    if rejection_event_id is not None:
        payload["rejection_event_id"] = str(rejection_event_id)
    async with database.sessions.begin() as session:
        # Verify ownership even for a replay: a cached result is not authority.
        order = await get_order(session, order_id, principal)
        require_master_owner(order, principal)
        replay = await idempotent(session, principal, key, action, payload)
        if replay is not None:
            return replay
        await session.refresh(order, with_for_update=True)
        require_master_owner(order, principal)
        check_version(order, body.expected_version)
        now = datetime.now(UTC)
        if isinstance(body, DowntimeRecord):
            if body.started_at is not None and (
                body.started_at > now
                or body.started_at < order.issued_at - timedelta(days=366)
                or (body.ended_at is None and now - body.started_at > timedelta(days=366))
            ):
                raise OperationError(422, "invalid_downtime_interval")
            if body.ended_at is not None and body.ended_at > now:
                raise OperationError(422, "downtime_end_in_future")
            details: dict[str, Any] = {
                "started_at": body.started_at.astimezone(UTC).isoformat()
                if body.started_at is not None
                else None,
                "ended_at": body.ended_at.astimezone(UTC).isoformat()
                if body.ended_at is not None
                else None,
                "reason": body.reason,
                "void": body.void,
            }
        else:
            rejection = await session.scalar(
                select(WorkOrderEvent).where(
                    WorkOrderEvent.id == rejection_event_id,
                    WorkOrderEvent.work_order_id == order.id,
                    WorkOrderEvent.action == "reject",
                    WorkOrderEvent.actor_id.is_not(None),
                )
            )
            if rejection is None:
                raise OperationError(404, "rejection_event_not_found")
            details = {
                "rejection_event_id": str(rejection.id),
                "justified": body.justified,
                "reason": body.reason,
            }
        # Supplemental observations may be recorded after closure. The lifecycle and
        # repair evidence are untouched; every correction is another immutable event.
        order.version += 1
        await record_event(
            session,
            order,
            principal,
            action,
            order.status,
            reason=body.reason,
            details=details,
            at=now,
        )
        result = mutation_result(order)
        await remember(session, principal, key, action, payload, result)
        return result
