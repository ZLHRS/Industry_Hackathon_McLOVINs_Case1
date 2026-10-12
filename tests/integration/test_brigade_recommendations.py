"""Real PostgreSQL checks for explainable brigade recommendations."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from naryadai.application.common import OperationError
from naryadai.application.queries import brigade_options
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import WorkOrderStatus
from naryadai.infrastructure.models import (
    AIReview,
    Area,
    Brigade,
    Employee,
    EmployeeArea,
    Equipment,
    FaultCode,
    Priority,
    WorkOrder,
    WorkOrderParticipant,
    WorkType,
)

pytestmark = pytest.mark.asyncio
pytest_plugins = ("test_order_api",)


async def _fixture(database):
    now = datetime.now(UTC)
    async with database.sessions.begin() as session:
        area = Area(code="REC", name="Recommendation area")
        less_fit = Brigade(code="A-TEAM", name="Alphabetically first")
        specialist_team = Brigade(code="B-TEAM", name="Specialist team")
        session.add_all((area, less_fit, specialist_team))
        await session.flush()
        master = Employee(
            login="recommend-master",
            display_name="Master",
            role="master",
            specialty="maintenance",
            grade=5,
            password_hash="x",
        )
        crew = [
            Employee(
                login="rec-a-one",
                display_name="A one",
                role="executor",
                specialty="mechanic",
                grade=6,
                brigade_id=less_fit.id,
                password_hash="x",
            ),
            Employee(
                login="rec-a-two",
                display_name="A two",
                role="executor",
                specialty="mechanic",
                grade=4,
                brigade_id=less_fit.id,
                password_hash="x",
            ),
            Employee(
                login="rec-b-electric",
                display_name="Z electrician",
                role="executor",
                specialty=" Electrician ",
                grade=3,
                brigade_id=specialist_team.id,
                password_hash="x",
            ),
            Employee(
                login="rec-b-mechanic",
                display_name="B mechanic",
                role="executor",
                specialty="mechanic",
                grade=6,
                brigade_id=specialist_team.id,
                password_hash="x",
            ),
        ]
        session.add_all((master, *crew))
        await session.flush()
        session.add_all(
            EmployeeArea(employee_id=item.id, area_id=area.id) for item in (master, *crew)
        )
        equipment = Equipment(
            inventory_number="REC-PUMP",
            name="Recommendation pump",
            area_id=area.id,
            equipment_type="pump",
            criticality=3,
        )
        fault = FaultCode(code="REC-E", name="Electrical fault", specialty="electrician")
        session.add_all((equipment, fault))
        await session.flush()
        for index in range(3):
            closed = WorkOrder(
                number=f"REC-CLOSED-{index}",
                work_type=WorkType.UNPLANNED,
                description="Electrical maintenance",
                area_id=area.id,
                equipment_id=equipment.id,
                executor_id=crew[2].id,
                brigade_id=specialist_team.id,
                master_id=master.id,
                priority=Priority.NORMAL,
                status=WorkOrderStatus.CLOSED,
                issued_at=now - timedelta(days=10 + index),
                deadline=now - timedelta(days=9 + index),
                started_at=now - timedelta(days=9 + index),
                completed_at=now - timedelta(days=8 + index),
                closed_at=now - timedelta(days=7 + index),
            )
            session.add(closed)
            await session.flush()
            session.add(
                AIReview(
                    work_order_id=closed.id,
                    order_version=1,
                    score=5,
                    needs_master_review=False,
                    explanation="Scored closed work",
                    model_name="test",
                    created_at=now - timedelta(days=7 + index),
                )
            )
        active = WorkOrder(
            number="REC-ACTIVE",
            work_type=WorkType.UNPLANNED,
            description="Current electrical work",
            area_id=area.id,
            equipment_id=equipment.id,
            executor_id=crew[2].id,
            brigade_id=specialist_team.id,
            master_id=master.id,
            priority=Priority.NORMAL,
            status=WorkOrderStatus.IN_PROGRESS,
            issued_at=now - timedelta(hours=2),
            deadline=now + timedelta(hours=2),
            started_at=now - timedelta(hours=1),
        )
        session.add(active)
        await session.flush()
        # Responsible executor and frozen participant must contribute only one load unit.
        session.add(
            WorkOrderParticipant(
                work_order_id=active.id,
                employee_id=crew[2].id,
                display_name=crew[2].display_name,
                assignment_role="responsible",
            )
        )
        return {
            "area": area.id,
            "equipment": equipment.id,
            "fault": fault.id,
            "less_fit_brigade": less_fit.id,
            "less_fit_executor": crew[0].id,
            "specialist_brigade": specialist_team.id,
            "specialist": crew[2].id,
            "principal": Principal(
                employee_id=master.id,
                session_id=uuid4(),
                login=master.login,
                display_name=master.display_name,
                role="master",
                area_ids=(area.id,),
            ),
        }


async def _add_equal_profile_history(database, data, *, remove_specialist_load: bool) -> None:
    now = datetime.now(UTC)
    async with database.sessions.begin() as session:
        first = await session.get(Employee, data["less_fit_executor"])
        assert first is not None
        first.specialty = "electrician"
        first.grade = 3
        if remove_specialist_load:
            active = await session.scalar(select(WorkOrder).where(WorkOrder.number == "REC-ACTIVE"))
            assert active is not None
            await session.delete(active)
        for index in range(3):
            closed = WorkOrder(
                number=f"REC-LESS-FIT-{index}",
                work_type=WorkType.UNPLANNED,
                description="Electrical maintenance",
                area_id=data["area"],
                equipment_id=data["equipment"],
                executor_id=first.id,
                brigade_id=data["less_fit_brigade"],
                master_id=data["principal"].employee_id,
                priority=Priority.NORMAL,
                status=WorkOrderStatus.CLOSED,
                issued_at=now - timedelta(days=20 + index),
                deadline=now - timedelta(days=19 + index),
                started_at=now - timedelta(days=19 + index),
                completed_at=now - timedelta(days=18 + index),
                closed_at=now - timedelta(days=17 + index),
            )
            session.add(closed)
            await session.flush()
            session.add(
                AIReview(
                    work_order_id=closed.id,
                    order_version=1,
                    score=3,
                    needs_master_review=False,
                    explanation="Lower but valid history",
                    model_name="test",
                    created_at=now - timedelta(days=17 + index),
                )
            )


async def test_confirmed_specialty_precedes_name_and_quality_is_sampled_once(database) -> None:
    data = await _fixture(database)
    view = await brigade_options(
        database,
        data["principal"],
        data["area"],
        equipment_id=data["equipment"],
        description="Electrical fault at pump",
        fault_code_id=data["fault"],
    )
    assert view.context.specialty == "electrician"
    assert view.context.specialty_source == "confirmed"
    assert view.items[0].brigade.id == data["specialist_brigade"]
    assert view.items[0].recommended is True
    assert view.items[0].matching_specialists == 1
    assert view.items[0].quality_score == 5.0
    assert view.items[0].quality_sample_count == 3
    responsible = next(
        item for item in view.items[0].participants if item.employee_id == data["specialist"]
    )
    assert responsible.running_count == 1
    assert responsible.quality_score == 5.0 and responsible.quality_sample_count == 3
    # The other team has no scored sample: it is unknown, never a zero penalty.
    assert view.items[1].quality_score is None and view.items[1].quality_sample_count == 0


async def test_unknown_context_does_not_claim_recommendation_or_invent_specialty(database) -> None:
    data = await _fixture(database)
    view = await brigade_options(
        database,
        data["principal"],
        data["area"],
        equipment_id=data["equipment"],
        description="Need routine inspection",
    )
    assert view.context.specialty is None and view.context.specialty_source == "unknown"
    assert not any(item.recommended for item in view.items)
    assert all(item.specialty_match is None for item in view.items)


async def test_inactive_area_rejects_contextual_recommendation(database) -> None:
    data = await _fixture(database)
    async with database.sessions.begin() as session:
        area = await session.get(Area, data["area"])
        assert area is not None
        area.is_active = False
    with pytest.raises(OperationError, match="area_inactive"):
        await brigade_options(
            database,
            data["principal"],
            data["area"],
            equipment_id=data["equipment"],
            description="Electrical fault at pump",
        )


async def test_quality_breaks_equal_profile_load_grade_without_penalizing_unknown_history(
    database,
) -> None:
    data = await _fixture(database)
    await _add_equal_profile_history(database, data, remove_specialist_load=True)
    ranked = await brigade_options(
        database,
        data["principal"],
        data["area"],
        equipment_id=data["equipment"],
        description="Electrical fault",
        fault_code_id=data["fault"],
    )
    assert ranked.items[0].brigade.id == data["specialist_brigade"]
    assert ranked.items[0].suggested_responsible_id == data["specialist"]

    async with database.sessions.begin() as session:
        unknown = Employee(
            login="rec-unscored-electric",
            display_name="A unscored electrician",
            role="executor",
            specialty="electrician",
            grade=3,
            brigade_id=data["specialist_brigade"],
            password_hash="x",
        )
        session.add(unknown)
        await session.flush()
        session.add(EmployeeArea(employee_id=unknown.id, area_id=data["area"]))
        unknown_id = unknown.id
    with_unknown = await brigade_options(
        database,
        data["principal"],
        data["area"],
        equipment_id=data["equipment"],
        description="Electrical fault",
        fault_code_id=data["fault"],
    )
    specialist_option = next(
        item for item in with_unknown.items if item.brigade.id == data["specialist_brigade"]
    )
    assert specialist_option.suggested_responsible_id == unknown_id
    unknown_member = next(
        item for item in specialist_option.participants if item.employee_id == unknown_id
    )
    assert unknown_member.quality_score is None and unknown_member.quality_sample_count == 0


async def test_whole_crew_load_precedes_quality_for_equivalent_profile_teams(database) -> None:
    data = await _fixture(database)
    await _add_equal_profile_history(database, data, remove_specialist_load=False)
    ranked = await brigade_options(
        database,
        data["principal"],
        data["area"],
        equipment_id=data["equipment"],
        description="Electrical fault",
        fault_code_id=data["fault"],
    )
    assert ranked.items[0].brigade.id == data["less_fit_brigade"]
    assert ranked.items[0].quality_score == 3.0
    specialist_option = next(
        item for item in ranked.items if item.brigade.id == data["specialist_brigade"]
    )
    assert specialist_option.quality_score == 5.0


async def test_post_contract_keeps_get_compatible_and_scoped(api) -> None:
    client, headers = api["client"], api["headers"]
    body = {
        "area_id": str(api["areas"][0].id),
        "equipment_id": str(api["machines"][0].id),
        "description": "Leak at pump",
        "fault_code_id": str(api["fault"].id),
    }
    post = await client.post(
        "/api/v1/work-orders/brigade-options", json=body, headers=headers["master"]
    )
    assert post.status_code == 200
    payload = post.json()
    assert payload["context"] == {
        "specialty": "mechanic",
        "specialty_source": "confirmed",
        "quality_history_days": 180,
        "quality_minimum": 3,
    }
    legacy = await client.get(
        f"/api/v1/work-orders/brigade-options?area_id={api['areas'][0].id}",
        headers=headers["master"],
    )
    assert legacy.status_code == 200
    assert legacy.json()["context"]["specialty_source"] == "unknown"
    assert (
        await client.post(
            "/api/v1/work-orders/brigade-options", json=body, headers=headers["manager"]
        )
    ).status_code == 403
