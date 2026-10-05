"""Pure, deterministic lifecycle policy for a work order.

The module contains no persistence or object-level authorization. It verifies the
role allowed to issue a lifecycle command; application services must additionally
verify the actor's relationship to the individual work order.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum


class WorkOrderStatus(StrEnum):
    """Persisted workflow statuses. Overdue remains a calculated condition."""

    ISSUED = "issued"
    ACCEPTED = "accepted"
    QUEUED = "queued"
    REJECTED = "rejected"
    IN_PROGRESS = "in_progress"
    PAUSED = "paused"
    COMPLETED = "completed"
    AI_REVIEW = "ai_review"
    REWORK = "rework"
    CLOSED = "closed"
    CANCELLED = "cancelled"


class ActorRole(StrEnum):
    """Roles known to lifecycle policy, without object-level authorization."""

    EXECUTOR = "executor"
    MASTER = "master"
    MANAGER = "manager"
    ADMIN = "admin"
    SYSTEM = "system"


class AiAssessment(StrEnum):
    """The three verdicts produced by automated work-completion assessment."""

    ACCEPTED = "accepted"
    ACCEPTED_WITH_REMARKS = "accepted_with_remarks"
    REWORK_REQUIRED = "rework_required"


class Action(StrEnum):
    """Commands that may change a work-order lifecycle."""

    ACCEPT = "accept"
    QUEUE = "queue"
    REJECT = "reject"
    START = "start"
    PAUSE = "pause"
    RESUME = "resume"
    COMPLETE = "complete"
    START_AI_REVIEW = "start_ai_review"
    RECORD_AI_ASSESSMENT = "record_ai_assessment"
    MARK_REWORK = "mark_rework"
    CLOSE = "close"
    OVERRIDE_CLOSE = "override_close"
    REQUEST_REWORK = "request_rework"
    REASSIGN = "reassign"
    CANCEL = "cancel"


class LifecycleTransitionError(ValueError):
    """Raised when a requested command violates lifecycle policy."""


@dataclass(frozen=True, slots=True)
class LifecycleState:
    """Persisted lifecycle state for one work order.

    ``needs_master_review`` represents a low-confidence AI result without
    inventing a fourth verdict. It prevents ordinary close and requires a
    reasoned human override. An assessment can remain in terminal history; a
    new rework attempt clears both fields before its next completion.
    """

    status: WorkOrderStatus
    ai_assessment: AiAssessment | None = None
    needs_master_review: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.status, WorkOrderStatus):
            raise TypeError("status must be a WorkOrderStatus")
        if self.ai_assessment is not None and not isinstance(self.ai_assessment, AiAssessment):
            raise TypeError("ai_assessment must be an AiAssessment or None")
        if not isinstance(self.needs_master_review, bool):
            raise TypeError("needs_master_review must be a bool")


@dataclass(frozen=True, slots=True)
class LifecycleTransition:
    """Immutable audit result from a successful domain command."""

    before: LifecycleState
    after: LifecycleState
    action: Action
    actor_role: ActorRole
    occurred_at: datetime
    reason: str | None = None


_TERMINAL = frozenset({WorkOrderStatus.CLOSED, WorkOrderStatus.CANCELLED})
_OVERDUE_EXCLUDED = frozenset(
    {
        WorkOrderStatus.REJECTED,
        WorkOrderStatus.COMPLETED,
        WorkOrderStatus.AI_REVIEW,
        WorkOrderStatus.CLOSED,
        WorkOrderStatus.CANCELLED,
    }
)
_REASSIGNABLE = frozenset(
    {
        WorkOrderStatus.ISSUED,
        WorkOrderStatus.ACCEPTED,
        WorkOrderStatus.QUEUED,
        WorkOrderStatus.REJECTED,
        WorkOrderStatus.IN_PROGRESS,
        WorkOrderStatus.PAUSED,
        WorkOrderStatus.REWORK,
    }
)
_MIN_REASON_LENGTH = 3


def new_lifecycle() -> LifecycleState:
    """Create the initial state after the master issues an order."""

    return LifecycleState(WorkOrderStatus.ISSUED)


def is_overdue(state: LifecycleState, *, deadline: datetime, at: datetime) -> bool:
    """Calculate whether an order is overdue at an explicit UTC instant.

    Deadline equality is on time. Rework is intentionally included, so an
    expired deadline becomes overdue again immediately after an AI rework result.
    """

    _require_utc(deadline, "deadline")
    _require_utc(at, "at")
    return state.status not in _OVERDUE_EXCLUDED and at > deadline


def transition(
    state: LifecycleState,
    *,
    action: Action,
    actor_role: ActorRole,
    at: datetime,
    reason: str | None = None,
    assessment: AiAssessment | None = None,
    needs_master_review: bool | None = None,
) -> LifecycleTransition:
    """Apply one lifecycle command and return its immutable audit event.

    Rejection, pause, cancellation, and human overrides require a meaningful
    reason. A normal close needs an accepted AI verdict and no review flag.
    ``needs_master_review`` is only accepted by the system assessment command;
    all unrelated payloads fail closed.
    """

    if not isinstance(state, LifecycleState):
        raise TypeError("state must be a LifecycleState")
    if not isinstance(action, Action):
        raise TypeError("action must be an Action")
    if not isinstance(actor_role, ActorRole):
        raise TypeError("actor_role must be an ActorRole")
    _require_utc(at, "at")
    if state.status in _TERMINAL:
        raise LifecycleTransitionError(f"{state.status} orders are immutable")

    normalized_reason = _normalise_reason(reason)
    _validate_assessment(assessment)
    _validate_optional_bool(needs_master_review, "needs_master_review")
    if action is not Action.RECORD_AI_ASSESSMENT:
        _forbid_needs_master_review(action, needs_master_review)

    next_assessment = state.ai_assessment
    next_needs_master_review = state.needs_master_review

    if action is Action.ACCEPT:
        _guard(
            action,
            state,
            actor_role,
            ActorRole.EXECUTOR,
            WorkOrderStatus.ISSUED,
            WorkOrderStatus.QUEUED,
        )
        _forbid_assessment(action, assessment)
        next_status = WorkOrderStatus.ACCEPTED
    elif action is Action.QUEUE:
        _guard(action, state, actor_role, ActorRole.EXECUTOR, WorkOrderStatus.ISSUED)
        _forbid_assessment(action, assessment)
        next_status = WorkOrderStatus.QUEUED
    elif action is Action.REJECT:
        _guard(action, state, actor_role, ActorRole.EXECUTOR, WorkOrderStatus.ISSUED)
        _require_reason(action, normalized_reason)
        _forbid_assessment(action, assessment)
        next_status = WorkOrderStatus.REJECTED
    elif action is Action.START:
        _guard(
            action,
            state,
            actor_role,
            ActorRole.EXECUTOR,
            WorkOrderStatus.ACCEPTED,
            WorkOrderStatus.QUEUED,
            WorkOrderStatus.REWORK,
        )
        _forbid_assessment(action, assessment)
        next_status = WorkOrderStatus.IN_PROGRESS
        if state.status is WorkOrderStatus.REWORK:
            next_assessment = None
            next_needs_master_review = False
    elif action is Action.PAUSE:
        _guard(action, state, actor_role, ActorRole.EXECUTOR, WorkOrderStatus.IN_PROGRESS)
        _require_reason(action, normalized_reason)
        _forbid_assessment(action, assessment)
        next_status = WorkOrderStatus.PAUSED
    elif action is Action.RESUME:
        _guard(action, state, actor_role, ActorRole.EXECUTOR, WorkOrderStatus.PAUSED)
        _forbid_assessment(action, assessment)
        next_status = WorkOrderStatus.IN_PROGRESS
    elif action is Action.COMPLETE:
        _guard(action, state, actor_role, ActorRole.EXECUTOR, WorkOrderStatus.IN_PROGRESS)
        _forbid_assessment(action, assessment)
        next_status = WorkOrderStatus.COMPLETED
    elif action is Action.START_AI_REVIEW:
        _guard(action, state, actor_role, ActorRole.SYSTEM, WorkOrderStatus.COMPLETED)
        _forbid_assessment(action, assessment)
        next_status = WorkOrderStatus.AI_REVIEW
    elif action is Action.RECORD_AI_ASSESSMENT:
        _guard(action, state, actor_role, ActorRole.SYSTEM, WorkOrderStatus.AI_REVIEW)
        if assessment is None:
            if needs_master_review is not True:
                raise LifecycleTransitionError(
                    "an assessment or needs_master_review=True is required"
                )
            next_status = WorkOrderStatus.AI_REVIEW
            next_assessment = None
            next_needs_master_review = True
        elif assessment is AiAssessment.REWORK_REQUIRED:
            if needs_master_review:
                raise LifecycleTransitionError(
                    "rework_required assessment cannot need master review"
                )
            raise LifecycleTransitionError(
                "rework_required assessment must use the mark_rework action"
            )
        else:
            next_status = WorkOrderStatus.AI_REVIEW
            next_assessment = assessment
            next_needs_master_review = needs_master_review is True
    elif action is Action.MARK_REWORK:
        _guard(action, state, actor_role, ActorRole.SYSTEM, WorkOrderStatus.AI_REVIEW)
        _forbid_assessment_not_rework(assessment)
        if state.needs_master_review:
            raise LifecycleTransitionError("cannot mark rework while master review is needed")
        next_status = WorkOrderStatus.REWORK
        next_assessment = assessment
    elif action is Action.CLOSE:
        _guard(action, state, actor_role, ActorRole.MASTER, WorkOrderStatus.AI_REVIEW)
        _forbid_assessment(action, assessment)
        if state.needs_master_review or state.ai_assessment not in {
            AiAssessment.ACCEPTED,
            AiAssessment.ACCEPTED_WITH_REMARKS,
        }:
            raise LifecycleTransitionError(
                "close requires an accepted AI assessment without master review"
            )
        next_status = WorkOrderStatus.CLOSED
    elif action is Action.OVERRIDE_CLOSE:
        _guard(
            action,
            state,
            actor_role,
            ActorRole.MASTER,
            WorkOrderStatus.AI_REVIEW,
            WorkOrderStatus.REWORK,
        )
        _require_reason(action, normalized_reason)
        _forbid_assessment(action, assessment)
        is_rework = (
            state.status is WorkOrderStatus.REWORK
            and state.ai_assessment is AiAssessment.REWORK_REQUIRED
        )
        if not (is_rework or state.needs_master_review):
            raise LifecycleTransitionError(
                "override_close requires rework_required or master review"
            )
        next_status = WorkOrderStatus.CLOSED
    elif action is Action.REQUEST_REWORK:
        _guard(action, state, actor_role, ActorRole.MASTER, WorkOrderStatus.AI_REVIEW)
        _require_reason(action, normalized_reason)
        _forbid_assessment(action, assessment)
        next_status = WorkOrderStatus.REWORK
    elif action is Action.REASSIGN:
        if actor_role is not ActorRole.MASTER:
            raise LifecycleTransitionError("reassign requires role master")
        if state.status not in _REASSIGNABLE:
            raise LifecycleTransitionError(f"cannot reassign an order in {state.status}")
        _forbid_assessment(action, assessment)
        next_status = WorkOrderStatus.ISSUED
        next_assessment = None
        next_needs_master_review = False
    elif action is Action.CANCEL:
        if actor_role is not ActorRole.MASTER:
            raise LifecycleTransitionError("cancel requires role master")
        _require_reason(action, normalized_reason)
        _forbid_assessment(action, assessment)
        next_status = WorkOrderStatus.CANCELLED
    else:
        raise LifecycleTransitionError(f"unsupported lifecycle action: {action}")

    return LifecycleTransition(
        before=state,
        after=LifecycleState(
            status=next_status,
            ai_assessment=next_assessment,
            needs_master_review=next_needs_master_review,
        ),
        action=action,
        actor_role=actor_role,
        occurred_at=at,
        reason=normalized_reason,
    )


def _require_utc(value: datetime, field_name: str) -> None:
    if not isinstance(value, datetime):
        raise TypeError(f"{field_name} must be a datetime")
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field_name} must be timezone-aware UTC")


def _normalise_reason(reason: str | None) -> str | None:
    if reason is None:
        return None
    if not isinstance(reason, str):
        raise TypeError("reason must be a string or None")
    return reason.strip() or None


def _validate_assessment(assessment: AiAssessment | None) -> None:
    if assessment is not None and not isinstance(assessment, AiAssessment):
        raise TypeError("assessment must be an AiAssessment or None")


def _validate_optional_bool(value: bool | None, field_name: str) -> None:
    if value is not None and not isinstance(value, bool):
        raise TypeError(f"{field_name} must be a bool or None")


def _guard(
    action: Action,
    state: LifecycleState,
    role: ActorRole,
    expected_role: ActorRole,
    *statuses: WorkOrderStatus,
) -> None:
    if role is not expected_role:
        raise LifecycleTransitionError(f"{action} requires role {expected_role}")
    if state.status not in statuses:
        names = ", ".join(status.value for status in statuses)
        raise LifecycleTransitionError(
            f"{action} is not allowed from {state.status}; expected one of: {names}"
        )


def _require_reason(action: Action, reason: str | None) -> None:
    if reason is None or len(reason) < _MIN_REASON_LENGTH:
        raise LifecycleTransitionError(
            f"{action} requires a meaningful reason of at least {_MIN_REASON_LENGTH} characters"
        )


def _forbid_assessment_not_rework(assessment: AiAssessment | None) -> None:
    if assessment is not AiAssessment.REWORK_REQUIRED:
        raise LifecycleTransitionError("mark_rework requires a rework_required AI assessment")


def _forbid_assessment(action: Action, assessment: AiAssessment | None) -> None:
    if assessment is not None:
        raise LifecycleTransitionError(f"{action} does not accept an AI assessment")


def _forbid_needs_master_review(action: Action, needs_master_review: bool | None) -> None:
    if needs_master_review is not None:
        raise LifecycleTransitionError(f"{action} does not accept needs_master_review")
