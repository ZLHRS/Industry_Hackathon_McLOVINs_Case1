"""Transactional work-order command handling and the internal AI-review seam."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import select
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
)
from naryadai.application.contracts import Completion, CreateOrder, OrderAction
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import (
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
    Employee,
    EmployeeArea,
    EmployeeRole,
    Equipment,
    FaultCode,
    Material,
    MaterialUsage,
    WorkOrder,
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
    if await session.get(FaultCode, fault_code_id) is None:
        raise OperationError(422, "fault_code_not_found")


async def _verify_materials(session: AsyncSession, completion: Completion) -> None:
    material_ids = {line.material_id for line in completion.materials}
    if not material_ids:
        return
    found = set(
        (await session.scalars(select(Material.id).where(Material.id.in_(material_ids)))).all()
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


async def create_order(
    database: Database, principal: Principal, body: CreateOrder, key: str
) -> dict[str, Any]:
    """Issue an order in an owned area and assign a qualified executor."""

    ensure_role(principal, "master")
    if body.area_id not in principal.area_ids:
        raise OperationError(404, "area_not_found")

    payload = body.model_dump(mode="json")
    async with database.sessions.begin() as session:
        replay = await idempotent(session, principal, key, "create_order", payload)
        if replay is not None:
            return replay

        equipment = await session.scalar(
            select(Equipment.id).where(
                Equipment.id == body.equipment_id, Equipment.area_id == body.area_id
            )
        )
        if equipment is None:
            raise OperationError(422, "equipment_not_in_area")
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
            master_id=principal.employee_id,
            priority=body.priority,
            status=WorkOrderStatus.ISSUED,
            issued_at=issued_at,
            deadline=body.deadline.astimezone(UTC),
            fault_code_id=body.fault_code_id,
            comment=body.comment,
            version=1,
            attempt=1,
        )
        session.add(order)
        await session.flush()
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
                "priority": order.priority.value,
                "deadline": order.deadline.isoformat(),
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
            require_executor(order, principal)
        else:
            require_master_owner(order, principal)
        return
    raise OperationError(422, "unsupported_action")


async def _prepare_active_executor(session: AsyncSession, order: WorkOrder) -> None:
    rows = await _lock_employees(session, {order.executor_id})
    executor = rows.get(order.executor_id)
    if (
        executor is None
        or executor.role is not EmployeeRole.EXECUTOR
        or not executor.is_active
        or not executor.is_on_shift
    ):
        raise OperationError(409, "executor_must_be_active_and_on_shift")
    membership = await session.scalar(
        select(EmployeeArea.employee_id).where(
            EmployeeArea.employee_id == executor.id, EmployeeArea.area_id == order.area_id
        )
    )
    if membership is None:
        raise OperationError(409, "executor_not_qualified_for_order_area")
    busy = await session.scalar(
        select(WorkOrder.id).where(
            WorkOrder.executor_id == executor.id,
            WorkOrder.status == WorkOrderStatus.IN_PROGRESS,
            WorkOrder.id != order.id,
        )
    )
    if busy is not None:
        raise OperationError(409, "executor_busy")


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
            await _executor_for_area(session, body.executor_id, order.area_id, lock=True)
            changed = _apply_transition(
                await _lifecycle_state(session, order),
                Action.REASSIGN,
                ActorRole.MASTER,
                at=at,
                reason=body.reason,
            )
            previous_executor_id = order.executor_id
            order.executor_id = body.executor_id
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
            elif action in {Action.CLOSE, Action.OVERRIDE_CLOSE}:
                order.closed_at = at
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
    if verdict is None and not needs_master_review:
        raise OperationError(422, "review_requires_verdict_or_master_review")
    if verdict is AiAssessment.REWORK_REQUIRED and needs_master_review:
        raise OperationError(422, "rework_verdict_cannot_need_master_review")

    async with database.sessions.begin() as session:
        order = await session.scalar(
            select(WorkOrder).where(WorkOrder.id == order_id).with_for_update()
        )
        if order is None:
            raise OperationError(404, "order_not_found")
        check_version(order, expected_order_version)
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
                created_at=at,
            )
        )
        await session.flush()

        review_action = (
            Action.MARK_REWORK
            if verdict is AiAssessment.REWORK_REQUIRED
            else Action.RECORD_AI_ASSESSMENT
        )
        reviewed = _apply_transition(
            await _lifecycle_state(session, order),
            review_action,
            ActorRole.SYSTEM,
            at=at,
            assessment=verdict,
            needs_master_review=needs_master_review
            if review_action is Action.RECORD_AI_ASSESSMENT
            else None,
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
