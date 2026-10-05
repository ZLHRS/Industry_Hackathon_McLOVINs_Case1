from datetime import UTC, datetime, timedelta, timezone

import pytest

from naryadai.domain.lifecycle import (
    Action,
    ActorRole,
    AiAssessment,
    LifecycleState,
    LifecycleTransitionError,
    WorkOrderStatus,
    is_overdue,
    new_lifecycle,
    transition,
)

AT = datetime(2026, 10, 5, 9, 0, tzinfo=UTC)


def apply(
    state: LifecycleState,
    action: Action,
    role: ActorRole,
    *,
    reason: str | None = None,
    assessment: AiAssessment | None = None,
    needs_master_review: bool | None = None,
) -> LifecycleState:
    result = transition(
        state,
        action=action,
        actor_role=role,
        at=AT,
        reason=reason,
        assessment=assessment,
        needs_master_review=needs_master_review,
    )
    assert result.before is state
    assert result.action is action
    assert result.actor_role is role
    assert result.occurred_at == AT
    return result.after


def in_progress_order() -> LifecycleState:
    accepted = apply(new_lifecycle(), Action.ACCEPT, ActorRole.EXECUTOR)
    return apply(accepted, Action.START, ActorRole.EXECUTOR)


def ai_review_order() -> LifecycleState:
    completed = apply(in_progress_order(), Action.COMPLETE, ActorRole.EXECUTOR)
    return apply(completed, Action.START_AI_REVIEW, ActorRole.SYSTEM)


def rework_order() -> LifecycleState:
    return apply(
        ai_review_order(),
        Action.MARK_REWORK,
        ActorRole.SYSTEM,
        assessment=AiAssessment.REWORK_REQUIRED,
    )


def test_happy_path_closes_after_accepted_ai_assessment() -> None:
    state = apply(
        ai_review_order(),
        Action.RECORD_AI_ASSESSMENT,
        ActorRole.SYSTEM,
        assessment=AiAssessment.ACCEPTED_WITH_REMARKS,
    )

    closed = apply(state, Action.CLOSE, ActorRole.MASTER)

    assert closed.status is WorkOrderStatus.CLOSED
    assert closed.ai_assessment is AiAssessment.ACCEPTED_WITH_REMARKS


def test_executor_can_accept_queued_order() -> None:
    queued = apply(new_lifecycle(), Action.QUEUE, ActorRole.EXECUTOR)

    assert apply(queued, Action.ACCEPT, ActorRole.EXECUTOR).status is WorkOrderStatus.ACCEPTED


def test_rework_is_overdue_when_deadline_has_passed() -> None:
    rework = rework_order()

    assert rework.status is WorkOrderStatus.REWORK
    assert is_overdue(rework, deadline=AT - timedelta(seconds=1), at=AT)


def test_master_can_override_actual_rework_assessment_with_reason() -> None:
    closed = apply(
        rework_order(),
        Action.OVERRIDE_CLOSE,
        ActorRole.MASTER,
        reason="Master verified the repair on site",
    )

    assert closed.status is WorkOrderStatus.CLOSED


def test_rework_start_clears_prior_assessment_before_resubmission() -> None:
    restarted = apply(rework_order(), Action.START, ActorRole.EXECUTOR)

    assert restarted.status is WorkOrderStatus.IN_PROGRESS
    assert restarted.ai_assessment is None
    assert not restarted.needs_master_review

    resubmitted = apply(restarted, Action.COMPLETE, ActorRole.EXECUTOR)
    awaiting_assessment = apply(resubmitted, Action.START_AI_REVIEW, ActorRole.SYSTEM)
    with pytest.raises(LifecycleTransitionError, match="close requires"):
        apply(awaiting_assessment, Action.CLOSE, ActorRole.MASTER)
    with pytest.raises(LifecycleTransitionError, match="override_close requires"):
        apply(
            awaiting_assessment,
            Action.OVERRIDE_CLOSE,
            ActorRole.MASTER,
            reason="No stale verdict may be reused",
        )


def test_needs_master_review_has_no_fourth_ai_verdict_and_needs_override() -> None:
    review_needed = apply(
        ai_review_order(),
        Action.RECORD_AI_ASSESSMENT,
        ActorRole.SYSTEM,
        needs_master_review=True,
    )

    assert review_needed.ai_assessment is None
    assert review_needed.needs_master_review
    with pytest.raises(LifecycleTransitionError, match="close requires"):
        apply(review_needed, Action.CLOSE, ActorRole.MASTER)
    assert (
        apply(
            review_needed,
            Action.OVERRIDE_CLOSE,
            ActorRole.MASTER,
            reason="Master completed visual inspection",
        ).status
        is WorkOrderStatus.CLOSED
    )


@pytest.mark.parametrize("needs_master_review", [None, False])
def test_recording_no_verdict_requires_review_flag(needs_master_review: bool | None) -> None:
    with pytest.raises(LifecycleTransitionError, match="assessment or needs_master_review"):
        apply(
            ai_review_order(),
            Action.RECORD_AI_ASSESSMENT,
            ActorRole.SYSTEM,
            needs_master_review=needs_master_review,
        )


@pytest.mark.parametrize(
    ("action", "state", "role", "reason"),
    [
        (Action.CANCEL, new_lifecycle(), ActorRole.EXECUTOR, "No longer needed"),
        (Action.REASSIGN, new_lifecycle(), ActorRole.EXECUTOR, None),
        (Action.CLOSE, ai_review_order(), ActorRole.SYSTEM, None),
        (Action.CLOSE, ai_review_order(), ActorRole.EXECUTOR, None),
    ],
)
def test_privileged_commands_reject_wrong_roles(
    action: Action,
    state: LifecycleState,
    role: ActorRole,
    reason: str | None,
) -> None:
    with pytest.raises(LifecycleTransitionError, match="requires role master"):
        apply(state, action, role, reason=reason)


@pytest.mark.parametrize(
    ("action", "state", "assessment", "needs_master_review", "message"),
    [
        (
            Action.ACCEPT,
            new_lifecycle(),
            AiAssessment.ACCEPTED,
            None,
            "does not accept an AI assessment",
        ),
        (
            Action.START,
            in_progress_order(),
            None,
            True,
            "does not accept needs_master_review",
        ),
        (
            Action.MARK_REWORK,
            ai_review_order(),
            AiAssessment.ACCEPTED,
            None,
            "mark_rework requires",
        ),
        (
            Action.RECORD_AI_ASSESSMENT,
            ai_review_order(),
            AiAssessment.REWORK_REQUIRED,
            True,
            "cannot need master review",
        ),
    ],
)
def test_commands_reject_inappropriate_payloads(
    action: Action,
    state: LifecycleState,
    assessment: AiAssessment | None,
    needs_master_review: bool | None,
    message: str,
) -> None:
    with pytest.raises(LifecycleTransitionError, match=message):
        apply(
            state,
            action,
            ActorRole.SYSTEM
            if action in {Action.RECORD_AI_ASSESSMENT, Action.MARK_REWORK}
            else ActorRole.EXECUTOR,
            assessment=assessment,
            needs_master_review=needs_master_review,
        )


@pytest.mark.parametrize(
    ("action", "role"),
    [
        (Action.ACCEPT, ActorRole.EXECUTOR),
        (Action.CANCEL, ActorRole.MASTER),
        (Action.OVERRIDE_CLOSE, ActorRole.MASTER),
        (Action.START_AI_REVIEW, ActorRole.SYSTEM),
    ],
)
def test_terminal_states_reject_every_lifecycle_command(action: Action, role: ActorRole) -> None:
    for terminal in (WorkOrderStatus.CLOSED, WorkOrderStatus.CANCELLED):
        with pytest.raises(LifecycleTransitionError, match="immutable"):
            apply(
                LifecycleState(terminal),
                action,
                role,
                reason="Valid reason",
            )


@pytest.mark.parametrize(
    ("action", "state", "role", "reason"),
    [
        (Action.REJECT, new_lifecycle(), ActorRole.EXECUTOR, None),
        (Action.PAUSE, in_progress_order(), ActorRole.EXECUTOR, " "),
        (Action.CANCEL, new_lifecycle(), ActorRole.MASTER, "no"),
        (Action.OVERRIDE_CLOSE, ai_review_order(), ActorRole.MASTER, None),
    ],
)
def test_commands_requiring_reason_reject_missing_or_short_reason(
    action: Action,
    state: LifecycleState,
    role: ActorRole,
    reason: str | None,
) -> None:
    with pytest.raises(LifecycleTransitionError, match="meaningful reason"):
        apply(state, action, role, reason=reason)


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (WorkOrderStatus.ISSUED, True),
        (WorkOrderStatus.ACCEPTED, True),
        (WorkOrderStatus.QUEUED, True),
        (WorkOrderStatus.IN_PROGRESS, True),
        (WorkOrderStatus.PAUSED, True),
        (WorkOrderStatus.REWORK, True),
        (WorkOrderStatus.REJECTED, False),
        (WorkOrderStatus.COMPLETED, False),
        (WorkOrderStatus.AI_REVIEW, False),
        (WorkOrderStatus.CLOSED, False),
        (WorkOrderStatus.CANCELLED, False),
    ],
)
def test_overdue_is_derived_from_status_and_deadline(
    status: WorkOrderStatus, expected: bool
) -> None:
    assert (
        is_overdue(LifecycleState(status), deadline=AT - timedelta(microseconds=1), at=AT)
        is expected
    )
    assert not is_overdue(LifecycleState(status), deadline=AT, at=AT)


@pytest.mark.parametrize(
    "invalid_time",
    [
        datetime(2026, 10, 5, 9, 0),
        datetime(2026, 10, 5, 12, 0, tzinfo=timezone(timedelta(hours=3))),
    ],
)
def test_timestamp_must_be_aware_utc(invalid_time: datetime) -> None:
    with pytest.raises(ValueError, match="timezone-aware UTC"):
        transition(
            new_lifecycle(),
            action=Action.ACCEPT,
            actor_role=ActorRole.EXECUTOR,
            at=invalid_time,
        )
    with pytest.raises(ValueError, match="timezone-aware UTC"):
        is_overdue(new_lifecycle(), deadline=invalid_time, at=AT)


@pytest.mark.parametrize(
    ("action", "state", "role", "message"),
    [
        (Action.QUEUE, LifecycleState(WorkOrderStatus.ACCEPTED), ActorRole.EXECUTOR, "not allowed"),
        (
            Action.COMPLETE,
            LifecycleState(WorkOrderStatus.ACCEPTED),
            ActorRole.EXECUTOR,
            "not allowed",
        ),
        (Action.START_AI_REVIEW, in_progress_order(), ActorRole.SYSTEM, "not allowed"),
        (Action.CLOSE, rework_order(), ActorRole.MASTER, "not allowed"),
        (
            Action.REASSIGN,
            LifecycleState(WorkOrderStatus.COMPLETED),
            ActorRole.MASTER,
            "cannot reassign",
        ),
    ],
)
def test_commands_reject_wrong_source_state(
    action: Action,
    state: LifecycleState,
    role: ActorRole,
    message: str,
) -> None:
    with pytest.raises(LifecycleTransitionError, match=message):
        apply(state, action, role)


@pytest.mark.parametrize("role", [ActorRole.MANAGER, ActorRole.ADMIN])
def test_manager_and_admin_have_no_stage_one_lifecycle_command(role: ActorRole) -> None:
    with pytest.raises(LifecycleTransitionError, match="requires role master"):
        apply(new_lifecycle(), Action.CANCEL, role, reason="Operational decision")


def test_master_requests_rework_from_accepted_ai_review_without_overwriting_verdict() -> None:
    reviewed = apply(
        ai_review_order(),
        Action.RECORD_AI_ASSESSMENT,
        ActorRole.SYSTEM,
        assessment=AiAssessment.ACCEPTED,
    )

    rework = apply(
        reviewed,
        Action.REQUEST_REWORK,
        ActorRole.MASTER,
        reason="Master found incomplete guard installation",
    )

    assert rework.status is WorkOrderStatus.REWORK
    assert rework.ai_assessment is AiAssessment.ACCEPTED
    assert not rework.needs_master_review


def test_master_requests_rework_from_low_confidence_ai_review_without_overwriting_flag() -> None:
    review_needed = apply(
        ai_review_order(),
        Action.RECORD_AI_ASSESSMENT,
        ActorRole.SYSTEM,
        needs_master_review=True,
    )

    rework = apply(
        review_needed,
        Action.REQUEST_REWORK,
        ActorRole.MASTER,
        reason="Master requires a corrected photo and report",
    )

    assert rework.status is WorkOrderStatus.REWORK
    assert rework.ai_assessment is None
    assert rework.needs_master_review


@pytest.mark.parametrize("role", [ActorRole.EXECUTOR, ActorRole.SYSTEM])
def test_request_rework_requires_master_role(role: ActorRole) -> None:
    with pytest.raises(LifecycleTransitionError, match="requires role master"):
        apply(
            ai_review_order(),
            Action.REQUEST_REWORK,
            role,
            reason="Return to executor",
        )


def test_request_rework_requires_meaningful_reason() -> None:
    with pytest.raises(LifecycleTransitionError, match="meaningful reason"):
        apply(ai_review_order(), Action.REQUEST_REWORK, ActorRole.MASTER)


def test_queued_order_can_be_started_paused_resumed_and_completed() -> None:
    queued = apply(new_lifecycle(), Action.QUEUE, ActorRole.EXECUTOR)
    started = apply(queued, Action.START, ActorRole.EXECUTOR)
    paused = apply(started, Action.PAUSE, ActorRole.EXECUTOR, reason="Awaiting spare part")
    resumed = apply(paused, Action.RESUME, ActorRole.EXECUTOR)

    assert apply(resumed, Action.COMPLETE, ActorRole.EXECUTOR).status is WorkOrderStatus.COMPLETED


def test_master_can_cancel_and_reassign_orders() -> None:
    cancelled = apply(
        new_lifecycle(),
        Action.CANCEL,
        ActorRole.MASTER,
        reason="Equipment was removed from service",
    )
    rejected = apply(
        new_lifecycle(),
        Action.REJECT,
        ActorRole.EXECUTOR,
        reason="Executor has no permit",
    )

    reassigned = apply(rejected, Action.REASSIGN, ActorRole.MASTER)

    assert cancelled.status is WorkOrderStatus.CANCELLED
    assert reassigned == LifecycleState(WorkOrderStatus.ISSUED)
