"""PostgreSQL integration tests for transactional work-order commands."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select

import naryadai.application.orders as order_service
from naryadai.application.common import OperationError
from naryadai.application.contracts import Completion, CreateOrder, MaterialLine, OrderAction
from naryadai.application.orders import apply_review, create_order, execute_action
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import AiAssessment, WorkOrderStatus
from naryadai.infrastructure.models import (
    AIReview,
    Area,
    Employee,
    EmployeeArea,
    Equipment,
    FaultCode,
    Material,
    MaterialUsage,
    Priority,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

pytestmark = pytest.mark.asyncio


async def _fixture(database):
    async with database.sessions.begin() as session:
        area = Area(code="A1", name="Primary")
        session.add(area)
        await session.flush()
        master = Employee(
            login="master",
            display_name="Master",
            role="master",
            specialty="maintenance",
            grade=5,
            password_hash="x",
        )
        first = Employee(
            login="executor-one",
            display_name="Executor one",
            role="executor",
            specialty="mechanic",
            grade=4,
            password_hash="x",
        )
        second = Employee(
            login="executor-two",
            display_name="Executor two",
            role="executor",
            specialty="mechanic",
            grade=4,
            password_hash="x",
        )
        session.add_all([master, first, second])
        await session.flush()
        for employee in (master, first, second):
            session.add(EmployeeArea(employee_id=employee.id, area_id=area.id))
        equipment = Equipment(
            inventory_number="PUMP-1",
            name="Pump",
            area_id=area.id,
            equipment_type="pump",
            criticality=4,
        )
        fault = FaultCode(code="F1", name="Wear", specialty="mechanic")
        material = Material(code="M1", name="Seal", unit="piece")
        session.add_all([equipment, fault, material])
        await session.flush()

        def principal(employee: Employee) -> Principal:
            return Principal(
                employee_id=employee.id,
                session_id=uuid4(),
                login=employee.login,
                display_name=employee.display_name,
                role=str(employee.role),
                area_ids=(area.id,),
            )

        return {
            "area": area.id,
            "equipment": equipment.id,
            "fault": fault.id,
            "material": material.id,
            "master": principal(master),
            "first": principal(first),
            "second": principal(second),
        }


def _create_body(data) -> CreateOrder:
    return CreateOrder(
        work_type=WorkType.UNPLANNED,
        description="Replace worn seal",
        area_id=data["area"],
        equipment_id=data["equipment"],
        executor_id=data["first"].employee_id,
        priority=Priority.HIGH,
        deadline=datetime.now(UTC) + timedelta(days=1),
    )


async def test_order_completion_review_rework_and_new_submission(database) -> None:
    data = await _fixture(database)
    created = await create_order(database, data["master"], _create_body(data), "create-key-0001")
    assert created["status"] == "issued"
    assert created["number"].startswith("NR-")

    accepted = await execute_action(
        database,
        data["first"],
        UUID(created["order_id"]),
        OrderAction(action="accept", expected_version=1),
        "accept-key-0001",
    )
    started = await execute_action(
        database,
        data["first"],
        UUID(created["order_id"]),
        OrderAction(action="start", expected_version=accepted["version"]),
        "start-key-00001",
    )
    completed = await execute_action(
        database,
        data["first"],
        UUID(created["order_id"]),
        OrderAction(
            action="complete",
            expected_version=started["version"],
            completion=Completion(
                work_description="Replaced seal and pressure-tested pump",
                fault_code_id=data["fault"],
                materials=(MaterialLine(material_id=data["material"], quantity="1.000"),),
            ),
        ),
        "complete-key-001",
    )
    review = await apply_review(
        database,
        UUID(created["order_id"]),
        expected_order_version=completed["version"],
        submission_version=completed["version"],
        verdict=AiAssessment.ACCEPTED,
        needs_master_review=False,
        score=5,
        explanation="Evidence is sufficient.",
        model_name="test-model",
    )
    assert review["status"] == "ai_review"

    async with database.sessions() as session:
        original_review = await session.scalar(
            select(AIReview).where(AIReview.work_order_id == UUID(created["order_id"]))
        )
        assert original_review is not None
        assert original_review.verdict is AiAssessment.ACCEPTED
    rework = await execute_action(
        database,
        data["master"],
        UUID(created["order_id"]),
        OrderAction(
            action="request_rework",
            expected_version=review["version"],
            reason="Please add the pressure reading.",
        ),
        "rework-key-0001",
    )
    restarted = await execute_action(
        database,
        data["first"],
        UUID(created["order_id"]),
        OrderAction(action="start", expected_version=rework["version"]),
        "restart-key-001",
    )
    assert restarted["status"] == "in_progress"
    resubmitted = await execute_action(
        database,
        data["first"],
        UUID(created["order_id"]),
        OrderAction(
            action="complete",
            expected_version=restarted["version"],
            completion=Completion(
                work_description="Added the measured pressure reading.",
                fault_code_id=data["fault"],
                no_materials_reason="No additional material was needed.",
            ),
        ),
        "resubmit-key-0001",
    )
    with pytest.raises(OperationError, match="stale_submission_review"):
        await apply_review(
            database,
            UUID(created["order_id"]),
            expected_order_version=resubmitted["version"],
            submission_version=completed["version"],
            verdict=AiAssessment.ACCEPTED,
            needs_master_review=False,
            score=5,
            explanation="Late review for the obsolete attempt.",
            model_name="test-model",
        )

    async with database.sessions() as session:
        order = await session.get(WorkOrder, UUID(created["order_id"]))
        assert order is not None
        assert order.attempt == 2
        assert order.last_submission_version == resubmitted["version"]
        assert (
            await session.scalar(
                select(MaterialUsage.quantity).where(
                    MaterialUsage.work_order_id == order.id,
                    MaterialUsage.submission_version == completed["version"],
                )
            )
            == 1
        )
        assert await session.scalar(
            select(WorkOrderEvent).where(WorkOrderEvent.work_order_id == order.id)
        )
        reviews = list(
            (
                await session.scalars(select(AIReview).where(AIReview.work_order_id == order.id))
            ).all()
        )
        assert len(reviews) == 1
        assert order.status is WorkOrderStatus.COMPLETED


async def test_idempotency_version_scope_and_reassignment_reset(database) -> None:
    data = await _fixture(database)
    created = await create_order(database, data["master"], _create_body(data), "create-key-0002")
    order_id = UUID(created["order_id"])
    accepted = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="accept", expected_version=1),
        "accept-key-0002",
    )
    replay = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="accept", expected_version=1),
        "accept-key-0002",
    )
    assert replay == accepted

    with pytest.raises(OperationError, match="version_conflict"):
        await execute_action(
            database,
            data["first"],
            order_id,
            OrderAction(action="start", expected_version=1),
            "start-stale-key1",
        )

    reassigned = await execute_action(
        database,
        data["master"],
        order_id,
        OrderAction(
            action="reassign",
            expected_version=accepted["version"],
            executor_id=data["second"].employee_id,
            reason="Balance the current shift.",
        ),
        "reassign-key-001",
    )
    assert reassigned["status"] == WorkOrderStatus.ISSUED.value
    with pytest.raises(OperationError, match="order_not_found"):
        await execute_action(
            database,
            data["first"],
            order_id,
            OrderAction(action="queue", expected_version=reassigned["version"]),
            "old-executor-key",
        )

    async with database.sessions() as session:
        order = await session.get(WorkOrder, order_id)
        assert order is not None
        assert order.executor_id == data["second"].employee_id
        assert order.attempt == 2
        assert order.started_at is None
        assert order.completed_at is None
        assert order.last_submission_version is None


async def test_concurrent_start_serializes_busy_executor_and_idempotency(database) -> None:
    data = await _fixture(database)
    first = await create_order(database, data["master"], _create_body(data), "create-key-0003")
    second = await create_order(database, data["master"], _create_body(data), "create-key-0004")
    first_id, second_id = UUID(first["order_id"]), UUID(second["order_id"])
    first_accepted = await execute_action(
        database,
        data["first"],
        first_id,
        OrderAction(action="accept", expected_version=1),
        "accept-key-0003",
    )
    second_accepted = await execute_action(
        database,
        data["first"],
        second_id,
        OrderAction(action="accept", expected_version=1),
        "accept-key-0004",
    )
    results = await asyncio.gather(
        execute_action(
            database,
            data["first"],
            first_id,
            OrderAction(action="start", expected_version=first_accepted["version"]),
            "shared-start-key",
        ),
        execute_action(
            database,
            data["first"],
            second_id,
            OrderAction(action="start", expected_version=second_accepted["version"]),
            "other-start-key0",
        ),
        return_exceptions=True,
    )
    successful = [result for result in results if isinstance(result, dict)]
    failures = [result for result in results if isinstance(result, OperationError)]
    assert len(successful) == len(failures) == 1
    assert failures[0].detail == "executor_busy"

    started_order_id = UUID(successful[0]["order_id"])
    winner_key = "shared-start-key" if started_order_id == first_id else "other-start-key0"
    other_id = second_id if started_order_id == first_id else first_id
    other_version = (
        second_accepted["version"] if other_id == second_id else first_accepted["version"]
    )
    with pytest.raises(OperationError, match="idempotency_key_conflict"):
        await execute_action(
            database,
            data["first"],
            other_id,
            OrderAction(action="start", expected_version=other_version),
            winner_key,
        )
    async with database.sessions() as session:
        statuses = list(
            (
                await session.scalars(
                    select(WorkOrder.status).where(WorkOrder.id.in_([first_id, second_id]))
                )
            ).all()
        )
        assert statuses.count(WorkOrderStatus.IN_PROGRESS) == 1
        assert statuses.count(WorkOrderStatus.ACCEPTED) == 1


async def test_completion_rejects_duplicate_material_lines() -> None:
    material_id = uuid4()
    with pytest.raises(ValueError, match="duplicate"):
        Completion(
            work_description="Work done",
            fault_code_id=uuid4(),
            materials=(
                MaterialLine(material_id=material_id, quantity="1.000"),
                MaterialLine(material_id=material_id, quantity="2.000"),
            ),
        )


async def test_queue_pause_resume_priority_comment_cancel_and_terminal_guard(database) -> None:
    data = await _fixture(database)
    created = await create_order(database, data["master"], _create_body(data), "flow-create-key01")
    order_id = UUID(created["order_id"])
    queued = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="queue", expected_version=1),
        "queue-key-000001",
    )
    started = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="start", expected_version=queued["version"]),
        "queue-start-key01",
    )
    paused = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(
            action="pause", expected_version=started["version"], reason="Awaiting lockout."
        ),
        "pause-key-000001",
    )
    resumed = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="resume", expected_version=paused["version"]),
        "resume-key-00001",
    )
    prioritized = await execute_action(
        database,
        data["master"],
        order_id,
        OrderAction(
            action="change_priority",
            expected_version=resumed["version"],
            priority=Priority.EMERGENCY,
            reason="Production risk increased.",
        ),
        "priority-key-001",
    )
    commented = await execute_action(
        database,
        data["master"],
        order_id,
        OrderAction(
            action="comment",
            expected_version=prioritized["version"],
            comment="Escalated to emergency.",
        ),
        "comment-key-0001",
    )
    cancelled = await execute_action(
        database,
        data["master"],
        order_id,
        OrderAction(
            action="cancel", expected_version=commented["version"], reason="Asset isolated."
        ),
        "cancel-key-00001",
    )
    with pytest.raises(OperationError, match="terminal_order_is_immutable"):
        await execute_action(
            database,
            data["master"],
            order_id,
            OrderAction(
                action="comment", expected_version=cancelled["version"], comment="Too late."
            ),
            "terminal-key-000",
        )
    async with database.sessions() as session:
        events = list(
            (
                await session.scalars(
                    select(WorkOrderEvent).where(WorkOrderEvent.work_order_id == order_id)
                )
            ).all()
        )
        priority_event = next(event for event in events if event.action == "change_priority")
        assert priority_event.details["previous_priority"] == Priority.HIGH.value
        assert priority_event.details["priority"] == Priority.EMERGENCY.value


async def test_review_close_and_override_close_paths(database) -> None:
    data = await _fixture(database)

    async def completed_order(key_suffix: str) -> tuple[UUID, int]:
        created = await create_order(
            database, data["master"], _create_body(data), "review-create-" + key_suffix
        )
        order_id = UUID(created["order_id"])
        accepted = await execute_action(
            database,
            data["first"],
            order_id,
            OrderAction(action="accept", expected_version=1),
            "review-accept-" + key_suffix,
        )
        started = await execute_action(
            database,
            data["first"],
            order_id,
            OrderAction(action="start", expected_version=accepted["version"]),
            "review-start-" + key_suffix,
        )
        completed = await execute_action(
            database,
            data["first"],
            order_id,
            OrderAction(
                action="complete",
                expected_version=started["version"],
                completion=Completion(
                    work_description="Repair completed.",
                    fault_code_id=data["fault"],
                    no_materials_reason="No replacement material needed.",
                ),
            ),
            "review-complete-" + key_suffix,
        )
        return order_id, completed["version"]

    approved_id, approved_version = await completed_order("00001")
    reviewed = await apply_review(
        database,
        approved_id,
        expected_order_version=approved_version,
        submission_version=approved_version,
        verdict=AiAssessment.ACCEPTED,
        needs_master_review=False,
        score=5,
        explanation="Accepted.",
        model_name="test-model",
    )
    closed = await execute_action(
        database,
        data["master"],
        approved_id,
        OrderAction(action="close", expected_version=reviewed["version"]),
        "close-key-000001",
    )
    assert closed["status"] == WorkOrderStatus.CLOSED.value

    uncertain_id, uncertain_version = await completed_order("00002")
    uncertain = await apply_review(
        database,
        uncertain_id,
        expected_order_version=uncertain_version,
        submission_version=uncertain_version,
        verdict=None,
        needs_master_review=True,
        score=None,
        explanation="Evidence requires human review.",
        model_name="test-model",
    )
    overridden = await execute_action(
        database,
        data["master"],
        uncertain_id,
        OrderAction(
            action="override_close",
            expected_version=uncertain["version"],
            reason="Master validated the physical repair.",
            master_score=4,
        ),
        "override-key-001",
    )
    assert overridden["status"] == WorkOrderStatus.CLOSED.value
    async with database.sessions() as session:
        review = await session.scalar(
            select(AIReview).where(AIReview.work_order_id == uncertain_id)
        )
        assert review is not None and review.score is None and review.master_score == 4


async def test_create_and_completion_validation_roll_back(database) -> None:
    data = await _fixture(database)
    with pytest.raises(OperationError, match="deadline_must_be_in_the_future"):
        await create_order(
            database,
            data["master"],
            _create_body(data).model_copy(
                update={"deadline": datetime.now(UTC) - timedelta(seconds=1)}
            ),
            "past-deadline-key",
        )
    with pytest.raises(OperationError, match="equipment_not_in_area"):
        await create_order(
            database,
            data["master"],
            _create_body(data).model_copy(update={"equipment_id": uuid4()}),
            "wrong-equipmentkey",
        )
    async with database.sessions.begin() as session:
        unqualified = Employee(
            login="unqualified-executor",
            display_name="Unqualified executor",
            role="executor",
            specialty="mechanic",
            grade=3,
            password_hash="x",
        )
        session.add(unqualified)
        await session.flush()
        unqualified_id = unqualified.id
    with pytest.raises(OperationError, match="executor_must_be_active"):
        await create_order(
            database,
            data["master"],
            _create_body(data).model_copy(update={"executor_id": unqualified_id}),
            "unqualified-create",
        )
    restricted_master = Principal(
        employee_id=data["master"].employee_id,
        session_id=uuid4(),
        login="restricted-master",
        display_name="Restricted master",
        role="master",
        area_ids=(),
    )
    with pytest.raises(OperationError, match="area_not_found"):
        await create_order(database, restricted_master, _create_body(data), "scope-create-key")
    async with database.sessions.begin() as session:
        employee = await session.get(Employee, data["second"].employee_id)
        assert employee is not None
        employee.is_on_shift = False
    with pytest.raises(OperationError, match="executor_must_be_active"):
        await create_order(
            database,
            data["master"],
            _create_body(data).model_copy(update={"executor_id": data["second"].employee_id}),
            "off-shift-create",
        )

    created = await create_order(database, data["master"], _create_body(data), "rollback-create01")
    order_id = UUID(created["order_id"])
    accepted = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="accept", expected_version=1),
        "rollback-accept01",
    )
    started = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="start", expected_version=accepted["version"]),
        "rollback-start-001",
    )
    with pytest.raises(OperationError, match="material_not_found"):
        await execute_action(
            database,
            data["first"],
            order_id,
            OrderAction(
                action="complete",
                expected_version=started["version"],
                completion=Completion(
                    work_description="Attempted repair.",
                    fault_code_id=data["fault"],
                    materials=(MaterialLine(material_id=uuid4(), quantity="1.000"),),
                ),
            ),
            "rollback-complete",
        )
    async with database.sessions() as session:
        order = await session.get(WorkOrder, order_id)
        assert order is not None
        assert order.status is WorkOrderStatus.IN_PROGRESS
        assert order.version == started["version"]
        assert not list(
            (
                await session.scalars(
                    select(MaterialUsage).where(MaterialUsage.work_order_id == order_id)
                )
            ).all()
        )


async def test_expired_retry_replays_before_deadline_validation(database, monkeypatch) -> None:
    data = await _fixture(database)
    body = _create_body(data)
    first = await create_order(database, data["master"], body, "retry-expiry-key")
    monkeypatch.setattr(order_service, "_now", lambda: body.deadline + timedelta(days=1))
    replay = await create_order(database, data["master"], body, "retry-expiry-key")
    assert replay == first
    async with database.sessions() as session:
        assert await session.scalar(
            select(WorkOrder).where(WorkOrder.id == UUID(first["order_id"]))
        )
