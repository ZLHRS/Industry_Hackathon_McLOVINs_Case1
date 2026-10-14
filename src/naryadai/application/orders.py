"""Transactional work-order command handling and the internal AI-review seam."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import delete, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from naryadai.application.common import (
    OperationError,
    check_version,
    ensure_role,
    get_order,
    idempotent,
    mutation_result,
    record_event,
    remember,
    require_executor,
    require_master_owner,
    require_participant,
)
from naryadai.application.contracts import Completion, CreateOrder, OrderAction
from naryadai.application.prevention import prevention_event_details, validate_prevention_source
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import (
    EQUIPMENT_OCCUPYING_STATUSES,
    Action,
    ActorRole,
    AiAssessment,
    LifecycleState,
    LifecycleTransition,
    LifecycleTransitionError,
    WorkOrderStatus,
    transition,
)
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    AIReview,
    AIReviewJob,
    Area,
    Brigade,
    Employee,
    EmployeeArea,
    EmployeeRole,
    Equipment,
    FaultCode,
    FaultReport,
    Material,
    MaterialUsage,
    WorkOrder,
    WorkOrderParticipant,
)

_SYSTEM_PRINCIPAL = Principal(
    employee_id=UUID(int=0),
    session_id=UUID(int=0),
    login="system",
    display_name="System",
    role="system",
    area_ids=(),
)

_EXECUTOR_ACTIONS = {
    Action.ACCEPT,
    Action.QUEUE,
    Action.REJECT,
    Action.START,
    Action.PAUSE,
    Action.RESUME,
    Action.COMPLETE,
}
_MASTER_ACTIONS = {
    Action.REASSIGN,
    Action.CANCEL,
    Action.CLOSE,
    Action.OVERRIDE_CLOSE,
    Action.REQUEST_REWORK,
}


def _now() -> datetime:
    return datetime.now(UTC)


def _domain_error(error: LifecycleTransitionError) -> OperationError:
    return OperationError(409, f"invalid_transition:{error}")


async def _executor_for_area(
    session: AsyncSession, employee_id: UUID, area_id: UUID, *, lock: bool = False
) -> Employee:
    query = (
        select(Employee)
        .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
        .where(
            Employee.id == employee_id,
            Employee.role == EmployeeRole.EXECUTOR,
            Employee.is_active.is_(True),
            Employee.is_on_shift.is_(True),
            EmployeeArea.area_id == area_id,
        )
    )
    if lock:
        query = query.with_for_update()
    employee = await session.scalar(query)
    if employee is None:
        raise OperationError(422, "executor_must_be_active_on_shift_and_area_qualified")
    return employee


async def _brigade_participants_for_area(
    session: AsyncSession,
    *,
    brigade_id: UUID,
    participant_ids: tuple[UUID, ...],
    executor_id: UUID,
    area_id: UUID,
) -> dict[UUID, Employee]:
    """Validate the UI's exact, fresh snapshot while holding involved people."""

    brigade = await session.scalar(
        select(Brigade).where(Brigade.id == brigade_id).with_for_update()
    )
    if brigade is None:
        raise OperationError(422, "brigade_not_found")
    actual = set(
        (
            await session.scalars(
                select(Employee.id)
                .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
                .where(
                    Employee.brigade_id == brigade_id,
                    Employee.role == EmployeeRole.EXECUTOR,
                    Employee.is_active.is_(True),
                    Employee.is_on_shift.is_(True),
                    EmployeeArea.area_id == area_id,
                )
                .order_by(Employee.id)
                .with_for_update()
            )
        ).all()
    )
    requested = set(participant_ids)
    if requested != actual:
        raise OperationError(409, "brigade_membership_changed")
    if executor_id not in requested:
        raise OperationError(422, "executor_must_belong_to_brigade")
    rows = await _lock_employees(session, requested)
    if len(rows) != len(requested):
        raise OperationError(409, "brigade_membership_changed")
    return rows


async def _store_participants(
    session: AsyncSession, order: WorkOrder, people: dict[UUID, Employee] | None
) -> None:
    await session.execute(
        delete(WorkOrderParticipant).where(WorkOrderParticipant.work_order_id == order.id)
    )
    if people is None:
        return
    session.add_all(
        WorkOrderParticipant(
            work_order_id=order.id,
            employee_id=employee.id,
            display_name=employee.display_name,
            assignment_role="responsible" if employee.id == order.executor_id else "participant",
        )
        for employee in people.values()
    )
    await session.flush()


async def _master_for_area(session: AsyncSession, employee_id: UUID, area_id: UUID) -> None:
    """Lock and revalidate the issuing master against concurrent access changes."""

    master = await session.scalar(
        select(Employee).where(Employee.id == employee_id).with_for_update()
    )
    if (
        master is None
        or master.role is not EmployeeRole.MASTER
        or not master.is_active
        or await session.scalar(
            select(EmployeeArea.employee_id).where(
                EmployeeArea.employee_id == employee_id,
                EmployeeArea.area_id == area_id,
            )
        )
        is None
    ):
        raise OperationError(409, "master_must_be_active_and_area_qualified")


async def _lock_employees(session: AsyncSession, employee_ids: set[UUID]) -> dict[UUID, Employee]:
    """Lock employee rows in UUID order after the order row to avoid start races."""

    if not employee_ids:
        return {}
    rows = (
        await session.scalars(
            select(Employee)
            .where(Employee.id.in_(sorted(employee_ids, key=str)))
            .order_by(Employee.id)
            .with_for_update()
        )
    ).all()
    return {employee.id: employee for employee in rows}


async def _verify_fault_code(session: AsyncSession, fault_code_id: UUID | None) -> None:
    if fault_code_id is None:
        return
    fault = await session.scalar(
        select(FaultCode).where(FaultCode.id == fault_code_id).with_for_update()
    )
    if fault is None:
        raise OperationError(422, "fault_code_not_found")


async def _verify_materials(session: AsyncSession, completion: Completion) -> None:
    material_ids = {line.material_id for line in completion.materials}
    if not material_ids:
        return
    found = set(
        (
            await session.scalars(
                select(Material.id)
                .where(Material.id.in_(material_ids))
                .order_by(Material.id)
                .with_for_update()
            )
        ).all()
    )
    if found != material_ids:
        raise OperationError(422, "material_not_found")


async def _current_review(session: AsyncSession, order: WorkOrder) -> AIReview | None:
    if order.last_submission_version is None:
        return None
    return cast(
        AIReview | None,
        await session.scalar(
            select(AIReview).where(
                AIReview.work_order_id == order.id,
                AIReview.order_version == order.last_submission_version,
            )
        ),
    )


async def _lifecycle_state(session: AsyncSession, order: WorkOrder) -> LifecycleState:
    review = await _current_review(session, order)
    return LifecycleState(
        order.status,
        None if review is None else review.verdict,
        False if review is None else review.needs_master_review,
    )


def _apply_transition(
    state: LifecycleState,
    action: Action,
    actor_role: ActorRole,
    *,
    at: datetime,
    reason: str | None = None,
    assessment: AiAssessment | None = None,
    needs_master_review: bool | None = None,
) -> LifecycleTransition:
    try:
        return transition(
            state,
            action=action,
            actor_role=actor_role,
            at=at,
            reason=reason,
            assessment=assessment,
            needs_master_review=needs_master_review,
        )
    except LifecycleTransitionError as error:
        raise _domain_error(error) from error


def _assert_mutable(order: WorkOrder) -> None:
    if order.status in {WorkOrderStatus.CLOSED, WorkOrderStatus.CANCELLED}:
        raise OperationError(409, "terminal_order_is_immutable")


async def _active_catalog_for_order(
    session: AsyncSession, area_id: UUID, equipment_id: UUID
) -> None:
    """Lock the references used by a new assignment against concurrent archiving."""

    area = await session.scalar(select(Area).where(Area.id == area_id).with_for_update())
    if area is None:
        raise OperationError(422, "area_not_found")
    if not area.is_active:
        raise OperationError(409, "area_inactive")
    equipment = await session.scalar(
        select(Equipment)
        .where(Equipment.id == equipment_id, Equipment.area_id == area_id)
        .with_for_update()
    )
    if equipment is None:
        raise OperationError(422, "equipment_not_in_area")
    if not equipment.is_active:
        raise OperationError(409, "equipment_inactive")


async def _ensure_equipment_available_for_active_assignment(
    session: AsyncSession, equipment_id: UUID, *, excluding_order_id: UUID | None = None
) -> None:
    """Reject another open assignment while the equipment row lock is held.

    ``_active_catalog_for_order`` has already taken ``FOR UPDATE`` on this
    equipment row.  Issuance and reassignment both follow that same lock,
    which makes their active-assignment check serializable per equipment
    without changing historical work orders or requiring a partial unique
    index.
    """

    query = (
        select(WorkOrder.id)
        .where(
            WorkOrder.equipment_id == equipment_id,
            WorkOrder.status.in_(EQUIPMENT_OCCUPYING_STATUSES),
        )
    )
    if excluding_order_id is not None:
        query = query.where(WorkOrder.id != excluding_order_id)
    occupied_order_id = await session.scalar(query.limit(1))
    if occupied_order_id is not None:
        raise OperationError(409, "equipment_has_active_order")


async def _fault_report_for_conversion(
    session: AsyncSession, report_id: UUID, principal: Principal, body: CreateOrder
) -> FaultReport:
    report = await session.scalar(
        select(FaultReport).where(FaultReport.id == report_id).with_for_update()
    )
    if report is None or report.master_id != principal.employee_id:
        raise OperationError(404, "fault_report_not_found")
    if report.status != "open":
        raise OperationError(409, "fault_report_not_open")
    if report.equipment_id != body.equipment_id or report.area_id != body.area_id:
        raise OperationError(422, "fault_report_equipment_mismatch")
    return report


async def create_order(
    database: Database, principal: Principal, body: CreateOrder, key: str
) -> dict[str, Any]:
    """Issue an order in an owned area and assign a qualified executor."""

    ensure_role(principal, "master")
    if body.area_id not in principal.area_ids:
        raise OperationError(404, "area_not_found")

    payload = body.model_dump(mode="json")
    # Existing idempotency records predate this optional field.  Keep their
    # request hash stable for ordinary order creation.
    if body.prevention_source is None:
        payload.pop("prevention_source")
    async with database.sessions.begin() as session:
        await _master_for_area(session, principal.employee_id, body.area_id)
        replay = await idempotent(session, principal, key, "create_order", payload)
        if replay is not None:
            return replay

        prevention = None
        if body.prevention_source is not None:
            if body.work_type.value != "planned":
                raise OperationError(422, "prevention_order_must_be_planned")
            if body.equipment_id != body.prevention_source.equipment_id:
                raise OperationError(409, "prevention_equipment_mismatch")
            prevention = await validate_prevention_source(
                database, principal, body.prevention_source
            )
            if body.area_id != prevention.draft.area_id:
                raise OperationError(409, "prevention_area_mismatch")

        await _active_catalog_for_order(session, body.area_id, body.equipment_id)
        await _ensure_equipment_available_for_active_assignment(session, body.equipment_id)
        report = (
            await _fault_report_for_conversion(session, body.fault_report_id, principal, body)
            if body.fault_report_id is not None
            else None
        )
        brigade_people = (
            await _brigade_participants_for_area(
                session,
                brigade_id=body.brigade_id,
                participant_ids=body.participant_ids,
                executor_id=body.executor_id,
                area_id=body.area_id,
            )
            if body.brigade_id is not None
            else None
        )
        if brigade_people is None:
            await _executor_for_area(session, body.executor_id, body.area_id, lock=True)
        await _verify_fault_code(session, body.fault_code_id)

        issued_at = _now()
        if body.deadline <= issued_at:
            raise OperationError(422, "deadline_must_be_in_the_future")
        order = WorkOrder(
            number=f"NR-{issued_at:%Y%m%d}-{uuid4().hex[:12].upper()}",
            work_type=body.work_type,
            description=body.description,
            area_id=body.area_id,
            equipment_id=body.equipment_id,
            executor_id=body.executor_id,
            brigade_id=body.brigade_id,
            master_id=principal.employee_id,
            priority=body.priority,
            status=WorkOrderStatus.ISSUED,
            issued_at=issued_at,
            deadline=body.deadline.astimezone(UTC),
            fault_code_id=body.fault_code_id,
            comment=body.comment,
            fault_report_id=body.fault_report_id,
            version=1,
            attempt=1,
        )
        session.add(order)
        await session.flush()
        await _store_participants(session, order, brigade_people)
        if report is not None:
            report.status = "converted"
            report.version += 1
            report.resolved_at = issued_at
            from naryadai.application.notification_engine import new_fault_report_notification

            await new_fault_report_notification(
                session,
                employee_id=report.reporter_id,
                report=report,
                kind="fault_report_converted",
                title="По сообщению создан наряд",
                body=f"Мастер создал наряд {order.number} по вашему сообщению.",
                action_required=False,
                now=issued_at,
            )
        await record_event(
            session,
            order,
            principal,
            "issue",
            None,
            details={
                "number": order.number,
                "work_type": order.work_type.value,
                "description": order.description,
                "area_id": str(order.area_id),
                "equipment_id": str(order.equipment_id),
                "executor_id": str(order.executor_id),
                "brigade_id": None if order.brigade_id is None else str(order.brigade_id),
                "participant_ids": [str(item) for item in body.participant_ids],
                **({"fault_report_id": str(body.fault_report_id)} if body.fault_report_id else {}),
                "priority": order.priority.value,
                "deadline": order.deadline.isoformat(),
                **(
                    {"prevention_source": prevention_event_details(prevention)}
                    if prevention is not None
                    else {}
                ),
            },
            at=issued_at,
        )
        result = mutation_result(order) | {"number": order.number}
        await remember(session, principal, key, "create_order", payload, result)
        return result


def _authorize_command(order: WorkOrder, principal: Principal, action: str) -> None:
    if action in {item.value for item in _EXECUTOR_ACTIONS}:
        require_executor(order, principal)
        return
    if action in {item.value for item in _MASTER_ACTIONS} | {"change_priority"}:
        require_master_owner(order, principal)
        return
    if action == "comment":
        if principal.role == "executor":
            require_participant(order, principal)
        else:
            require_master_owner(order, principal)
        return
    raise OperationError(422, "unsupported_action")


async def _prepare_active_executor(session: AsyncSession, order: WorkOrder) -> None:
    snapshot_ids = set(
        (
            await session.scalars(
                select(WorkOrderParticipant.employee_id).where(
                    WorkOrderParticipant.work_order_id == order.id
                )
            )
        ).all()
    )
    participant_ids = snapshot_ids or {order.executor_id}
    rows = await _lock_employees(session, participant_ids)
    if set(rows) != participant_ids:
        raise OperationError(409, "participant_unavailable")
    for participant in rows.values():
        if (
            participant.role is not EmployeeRole.EXECUTOR
            or not participant.is_active
            or not participant.is_on_shift
        ):
            raise OperationError(409, "participant_must_be_active_and_on_shift")
        membership = await session.scalar(
            select(EmployeeArea.employee_id).where(
                EmployeeArea.employee_id == participant.id, EmployeeArea.area_id == order.area_id
            )
        )
        if membership is None:
            raise OperationError(409, "participant_not_qualified_for_order_area")
    busy = await session.scalar(
        select(WorkOrder.id).where(
            WorkOrder.status == WorkOrderStatus.IN_PROGRESS,
            WorkOrder.id != order.id,
            or_(
                WorkOrder.executor_id.in_(participant_ids),
                exists(
                    select(WorkOrderParticipant.work_order_id).where(
                        WorkOrderParticipant.work_order_id == WorkOrder.id,
                        WorkOrderParticipant.employee_id.in_(participant_ids),
                    )
                ),
            ),
        )
    )
    if busy is not None:
        raise OperationError(409, "participant_busy" if snapshot_ids else "executor_busy")


async def _apply_completion(
    session: AsyncSession, order: WorkOrder, completion: Completion, next_version: int
) -> None:
    await _verify_fault_code(session, completion.fault_code_id)
    await _verify_materials(session, completion)
    order.work_description = completion.work_description
    order.fault_code_id = completion.fault_code_id
    order.no_materials_reason = completion.no_materials_reason
    if completion.comment is not None:
        order.comment = completion.comment
    order.last_submission_version = next_version
    session.add(
        AIReviewJob(
            work_order_id=order.id,
            submission_version=next_version,
            status="pending",
            attempts=0,
            next_attempt_at=_now(),
        )
    )
    for line in completion.materials:
        session.add(
            MaterialUsage(
                work_order_id=order.id,
                material_id=line.material_id,
                quantity=line.quantity,
                submission_version=next_version,
            )
        )


async def execute_action(
    database: Database,
    principal: Principal,
    order_id: UUID,
    body: OrderAction,
    key: str,
) -> dict[str, Any]:
    """Apply one public human command with idempotency and optimistic concurrency."""

    payload = body.model_dump(mode="json")
    operation = f"order_action:{order_id}:{body.action}"
    async with database.sessions.begin() as session:
        replay = await idempotent(session, principal, key, operation, payload)
        if replay is not None:
            # Replays must retain the original action's current authorization,
            # even though they intentionally bypass a now-stale version check.
            replay_order = await get_order(session, order_id, principal)
            _authorize_command(replay_order, principal, body.action)
            return replay

        order = await get_order(session, order_id, principal, lock=True)
        check_version(order, body.expected_version)
        _assert_mutable(order)
        _authorize_command(order, principal, body.action)

        at = _now()
        from_status = order.status
        event_details: dict[str, Any] | None = None
        if body.action == "change_priority":
            assert body.priority is not None
            previous_priority = order.priority
            order.priority = body.priority
            order.version += 1
            await record_event(
                session,
                order,
                principal,
                body.action,
                from_status,
                reason=body.reason,
                details={
                    "previous_priority": previous_priority.value,
                    "priority": body.priority.value,
                },
                at=at,
            )
        elif body.action == "comment":
            assert body.comment is not None
            order.comment = body.comment
            order.version += 1
            await record_event(
                session,
                order,
                principal,
                body.action,
                from_status,
                details={"comment": body.comment},
                at=at,
            )
        elif body.action == "reassign":
            assert body.executor_id is not None
            await _active_catalog_for_order(session, order.area_id, order.equipment_id)
            await _ensure_equipment_available_for_active_assignment(
                session, order.equipment_id, excluding_order_id=order.id
            )
            brigade_people = (
                await _brigade_participants_for_area(
                    session,
                    brigade_id=body.brigade_id,
                    participant_ids=body.participant_ids,
                    executor_id=body.executor_id,
                    area_id=order.area_id,
                )
                if body.brigade_id is not None
                else None
            )
            if brigade_people is None:
                await _executor_for_area(session, body.executor_id, order.area_id, lock=True)
            changed = _apply_transition(
                await _lifecycle_state(session, order),
                Action.REASSIGN,
                ActorRole.MASTER,
                at=at,
                reason=body.reason,
            )
            previous_executor_id = order.executor_id
            previous_brigade_id = order.brigade_id
            previous_participant_ids = list(
                await session.scalars(
                    select(WorkOrderParticipant.employee_id).where(
                        WorkOrderParticipant.work_order_id == order.id
                    )
                )
            )
            order.executor_id = body.executor_id
            order.brigade_id = body.brigade_id
            await _store_participants(session, order, brigade_people)
            order.status = changed.after.status
            order.started_at = None
            order.completed_at = None
            order.closed_at = None
            order.last_submission_version = None
            order.work_description = None
            order.fault_code_id = None
            order.no_materials_reason = None
            order.attempt += 1
            order.version += 1
            await record_event(
                session,
                order,
                principal,
                body.action,
                from_status,
                reason=body.reason,
                details={
                    "previous_executor_id": str(previous_executor_id),
                    "executor_id": str(order.executor_id),
                    "previous_brigade_id": (
                        None if previous_brigade_id is None else str(previous_brigade_id)
                    ),
                    "brigade_id": None if order.brigade_id is None else str(order.brigade_id),
                    "participant_ids": [str(item) for item in body.participant_ids],
                    "previous_participant_ids": [str(item) for item in previous_participant_ids],
                },
                at=at,
            )
        else:
            action = Action(body.action)
            if action in {Action.START, Action.RESUME}:
                await _prepare_active_executor(session, order)
            changed = _apply_transition(
                await _lifecycle_state(session, order),
                action,
                ActorRole(principal.role),
                at=at,
                reason=body.reason,
            )
            if action is Action.START and from_status is WorkOrderStatus.REWORK:
                order.attempt += 1
                order.last_submission_version = None
                order.completed_at = None
            order.status = changed.after.status
            if action is Action.START:
                order.started_at = at
            elif action is Action.COMPLETE:
                assert body.completion is not None
                await _apply_completion(session, order, body.completion, order.version + 1)
                order.completed_at = at
                event_details = {
                    "submission_version": order.version + 1,
                    "work_description": body.completion.work_description,
                    "fault_code_id": str(body.completion.fault_code_id),
                    "materials": [
                        {"material_id": str(line.material_id), "quantity": str(line.quantity)}
                        for line in body.completion.materials
                    ],
                    "no_materials_reason": body.completion.no_materials_reason,
                    "comment": body.completion.comment,
                }
            elif action in {Action.CLOSE, Action.OVERRIDE_CLOSE, Action.REQUEST_REWORK}:
                if action in {Action.CLOSE, Action.OVERRIDE_CLOSE}:
                    order.closed_at = at
                review = await _current_review(session, order)
                if review is not None:
                    if (
                        action in {Action.CLOSE, Action.OVERRIDE_CLOSE}
                        and review.score is None
                        and body.master_score is None
                    ):
                        raise OperationError(422, "closed_order_requires_ai_or_master_score")
                    event_details = {
                        "review_id": str(review.id),
                        "submission_version": review.order_version,
                        "ai_verdict": review.verdict.value if review.verdict else None,
                        "ai_score": review.score,
                        "needs_master_review": review.needs_master_review,
                        "previous_master_score": review.master_score,
                        "master_score": body.master_score,
                    }
                    if body.master_score is not None:
                        review.master_score = body.master_score
                elif body.master_score is not None:
                    raise OperationError(409, "master_score_requires_current_review")
            order.version += 1
            await record_event(
                session,
                order,
                principal,
                body.action,
                from_status,
                reason=body.reason,
                details=event_details,
                at=at,
            )

        result = mutation_result(order)
        await remember(session, principal, key, operation, payload, result)
        return result


async def apply_review(
    database: Database,
    order_id: UUID,
    *,
    expected_order_version: int,
    submission_version: int,
    verdict: AiAssessment | None,
    needs_master_review: bool,
    score: int | None,
    explanation: str,
    model_name: str,
    report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Apply an internal assessment in its own transaction (tests and trusted callers)."""
    async with database.sessions.begin() as session:
        return await apply_review_in_session(
            session,
            order_id,
            expected_order_version=expected_order_version,
            submission_version=submission_version,
            verdict=verdict,
            needs_master_review=needs_master_review,
            score=score,
            explanation=explanation,
            model_name=model_name,
            report=report,
        )


async def apply_review_in_session(
    session: AsyncSession,
    order_id: UUID,
    *,
    expected_order_version: int,
    submission_version: int,
    verdict: AiAssessment | None,
    needs_master_review: bool,
    score: int | None,
    explanation: str,
    model_name: str,
    report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Persist a system assessment for the current completed submission.

    This internal seam deliberately has no HTTP route. The AI worker supplies
    provenance and the exact completed submission version, making late results
    harmless rather than applicable to a later rework attempt.
    """

    if not explanation.strip() or not model_name.strip():
        raise OperationError(422, "review_explanation_and_model_name_are_required")
    if score is not None and not 1 <= score <= 5:
        raise OperationError(422, "review_score_out_of_range")
    # AI output is evidence only.  Persisting an assessment always leaves the
    # order for a master to accept or return for rework, including a negative
    # verdict or an unavailable provider.
    if not needs_master_review:
        needs_master_review = True

    order = await session.scalar(
        select(WorkOrder).where(WorkOrder.id == order_id).with_for_update()
    )
    if order is None:
        raise OperationError(404, "order_not_found")
    if expected_order_version > order.version:
        raise OperationError(409, "stale_order_version")
    # Submission identity, rather than mutable order version, guards late results:
    # a comment may increment version while the same completed submission remains valid.
    if order.status is not WorkOrderStatus.COMPLETED:
        raise OperationError(409, "review_requires_completed_order")
    if order.last_submission_version != submission_version:
        raise OperationError(409, "stale_submission_review")

    at = _now()
    before = order.status
    start = _apply_transition(
        await _lifecycle_state(session, order),
        Action.START_AI_REVIEW,
        ActorRole.SYSTEM,
        at=at,
    )
    order.status = start.after.status
    order.version += 1
    await record_event(
        session,
        order,
        _SYSTEM_PRINCIPAL,
        Action.START_AI_REVIEW.value,
        before,
        at=at,
        system=True,
    )

    session.add(
        AIReview(
            work_order_id=order.id,
            order_version=submission_version,
            verdict=verdict,
            score=score,
            needs_master_review=needs_master_review,
            explanation=explanation.strip(),
            model_name=model_name.strip(),
            report=report or {},
            created_at=at,
        )
    )
    await session.flush()

    review_action = Action.RECORD_AI_ASSESSMENT
    reviewed = _apply_transition(
        await _lifecycle_state(session, order),
        review_action,
        ActorRole.SYSTEM,
        at=at,
        assessment=verdict,
        needs_master_review=needs_master_review,
    )
    before_review: WorkOrderStatus = order.status
    order.status = reviewed.after.status
    order.version += 1
    await record_event(
        session,
        order,
        _SYSTEM_PRINCIPAL,
        review_action.value,
        before_review,
        details={"submission_version": submission_version, "model_name": model_name.strip()},
        at=at,
        system=True,
    )
    return mutation_result(order)
