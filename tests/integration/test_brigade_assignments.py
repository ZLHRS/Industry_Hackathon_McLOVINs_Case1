"""PostgreSQL acceptance coverage for frozen brigade work-order assignments."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select

from naryadai.application.common import OperationError
from naryadai.application.contracts import Completion, CreateOrder, OrderAction
from naryadai.application.orders import apply_review, create_order, execute_action
from naryadai.application.queries import brigade_options, list_orders, order_detail
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import AiAssessment, WorkOrderStatus
from naryadai.infrastructure.models import (
    Area,
    Brigade,
    Employee,
    EmployeeArea,
    Equipment,
    FaultCode,
    Priority,
    WorkOrderParticipant,
    WorkType,
)

pytestmark = pytest.mark.asyncio


async def _team(database):
    async with database.sessions.begin() as session:
        area = Area(code="BR-A", name="Brigade area")
        brigade = Brigade(code="BR-1", name="Brigade one")
        session.add_all((area, brigade))
        await session.flush()
        master = Employee(
            login="brigade-master",
            display_name="Master",
            role="master",
            specialty="m",
            grade=5,
            password_hash="x",
        )
        first = Employee(
            login="brigade-one",
            display_name="One",
            role="executor",
            specialty="m",
            grade=4,
            brigade_id=brigade.id,
            password_hash="x",
        )
        second = Employee(
            login="brigade-two",
            display_name="Two",
            role="executor",
            specialty="m",
            grade=4,
            brigade_id=brigade.id,
            password_hash="x",
        )
        session.add_all((master, first, second))
        await session.flush()
        session.add_all(
            EmployeeArea(employee_id=person.id, area_id=area.id)
            for person in (master, first, second)
        )
        equipment = Equipment(
            inventory_number="BR-PUMP",
            name="Pump",
            area_id=area.id,
            equipment_type="pump",
            criticality=3,
        )
        fault = FaultCode(code="BR-F", name="Wear", specialty="m")
        session.add_all((equipment, fault))
        await session.flush()

        def principal(person):
            return Principal(
                employee_id=person.id,
                session_id=uuid4(),
                login=person.login,
                display_name=person.display_name,
                role=str(person.role),
                area_ids=(area.id,),
            )

        return {
            "area": area.id,
            "brigade": brigade.id,
            "equipment": equipment.id,
            "fault": fault.id,
            "master": principal(master),
            "first": principal(first),
            "second": principal(second),
        }


def _body(data, participant_ids=None):
    return CreateOrder(
        work_type=WorkType.UNPLANNED,
        description="Team repair",
        area_id=data["area"],
        equipment_id=data["equipment"],
        executor_id=data["first"].employee_id,
        brigade_id=data["brigade"],
        participant_ids=participant_ids or (data["first"].employee_id, data["second"].employee_id),
        priority=Priority.HIGH,
        deadline=datetime.now(UTC) + timedelta(days=1),
    )


async def test_brigade_full_cycle_freezes_roster_and_allows_participant_read(database):
    data = await _team(database)
    options = await brigade_options(database, data["master"], data["area"])
    assert options.items[0].participant_ids == [
        data["first"].employee_id,
        data["second"].employee_id,
    ]
    issued = await create_order(database, data["master"], _body(data), "brigade-new-001")
    order_id = UUID(issued["order_id"])
    # A directory transfer does not remove the assigned participant's access.
    async with database.sessions.begin() as session:
        employee = await session.get(Employee, data["second"].employee_id)
        assert employee is not None
        employee.brigade_id = None
    detail = await order_detail(database, data["second"], order_id)
    assert {row.employee_id for row in detail.participants} == {
        data["first"].employee_id,
        data["second"].employee_id,
    }
    commented = await execute_action(
        database,
        data["second"],
        order_id,
        OrderAction(action="comment", expected_version=1, comment="Checked jointly."),
        "brigade-note-001",
    )
    accepted = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="accept", expected_version=commented["version"]),
        "brigade-accept-01",
    )
    started = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(action="start", expected_version=accepted["version"]),
        "brigade-start-001",
    )
    completed = await execute_action(
        database,
        data["first"],
        order_id,
        OrderAction(
            action="complete",
            expected_version=started["version"],
            completion=Completion(
                work_description="Repaired together.",
                fault_code_id=data["fault"],
                no_materials_reason="No parts.",
            ),
        ),
        "brigade-complete1",
    )
    reviewed = await apply_review(
        database,
        order_id,
        expected_order_version=completed["version"],
        submission_version=completed["version"],
        verdict=AiAssessment.ACCEPTED,
        needs_master_review=False,
        score=5,
        explanation="Accepted.",
        model_name="test",
    )
    closed = await execute_action(
        database,
        data["master"],
        order_id,
        OrderAction(
            action="close",
            expected_version=reviewed["version"],
            reason="Master accepted the completed brigade work.",
        ),
        "brigade-close-001",
    )
    assert closed["status"] == WorkOrderStatus.CLOSED.value
    async with database.sessions() as session:
        assert (
            len(
                list(
                    await session.scalars(
                        select(WorkOrderParticipant).where(
                            WorkOrderParticipant.work_order_id == order_id
                        )
                    )
                )
            )
            == 2
        )


async def test_brigade_stale_snapshot_and_explicit_reassign_revoke_access(database):
    data = await _team(database)
    # Pydantic prevents malformed groups before they can issue a partial team.
    with pytest.raises(ValueError, match="at least two"):
        _body(data, (data["first"].employee_id,))
    issued = await create_order(database, data["master"], _body(data), "brigade-new-002")
    order_id = UUID(issued["order_id"])
    # Keep the former participant on another team assignment.  This guards the
    # correlated visibility predicate: that row must not authorize this order.
    other = await create_order(
        database,
        data["master"],
        _body(data).model_copy(update={"executor_id": data["second"].employee_id}),
        "brigade-new-003",
    )
    other_id = UUID(other["order_id"])
    old_comment = OrderAction(action="comment", expected_version=1, comment="Peer note.")
    commented = await execute_action(
        database, data["second"], order_id, old_comment, "brigade-peer-replay"
    )
    reassigned = await execute_action(
        database,
        data["master"],
        order_id,
        OrderAction(
            action="reassign",
            expected_version=commented["version"],
            executor_id=data["first"].employee_id,
            reason="Solo follow-up.",
        ),
        "brigade-solo-001",
    )
    with pytest.raises(OperationError, match="order_not_found"):
        await order_detail(database, data["second"], order_id)
    # An idempotent retry remains subject to current authorization and cannot
    # revive the former team member's access.
    with pytest.raises(OperationError, match="order_not_found"):
        await execute_action(database, data["second"], order_id, old_comment, "brigade-peer-replay")
    visible = await list_orders(database, data["second"], limit=50)
    assert all(item.id != order_id for item in visible.items)
    assert any(item.id == other_id for item in visible.items)
    assert reassigned["status"] == WorkOrderStatus.ISSUED.value
