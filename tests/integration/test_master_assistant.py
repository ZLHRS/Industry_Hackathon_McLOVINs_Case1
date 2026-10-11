"""HTTP acceptance checks for bounded, citation-grounded master assistance."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from pydantic import ValidationError

from naryadai.ai.contracts import OpenAIReviewConfig
from naryadai.ai.master_assistant import AssistantIntent
from naryadai.application.master_assistant import AssistantQuestion, master_assistant_answer
from naryadai.auth.dependencies import Principal
from naryadai.domain.lifecycle import ActorRole, WorkOrderStatus
from naryadai.infrastructure.models import Priority, WorkOrder, WorkOrderEvent, WorkType

pytestmark = pytest.mark.asyncio
pytest_plugins = ("test_order_api",)


async def _order(
    database,
    api,
    *,
    number,
    status,
    issued_at,
    equipment_id,
    fault_id,
    closed=False,
    close_role=ActorRole.MASTER,
):
    async with database.sessions.begin() as session:
        order = WorkOrder(
            number=number,
            work_type=WorkType.UNPLANNED,
            description="Seal leak repair",
            area_id=api["areas"][0].id,
            equipment_id=equipment_id,
            executor_id=api["users"]["executor"],
            master_id=api["users"]["master"],
            priority=Priority.HIGH,
            status=status,
            issued_at=issued_at,
            deadline=issued_at + timedelta(hours=1),
            started_at=issued_at + timedelta(minutes=5) if closed else None,
            completed_at=issued_at + timedelta(minutes=10) if closed else None,
            closed_at=issued_at + timedelta(minutes=20) if closed else None,
            fault_code_id=fault_id,
            work_description="Replaced seal and checked for leaks." if closed else None,
            version=3 if closed else 1,
            attempt=1,
            last_submission_version=2 if closed else None,
        )
        session.add(order)
        await session.flush()
        if closed:
            session.add(
                WorkOrderEvent(
                    work_order_id=order.id,
                    sequence=1,
                    order_version=3,
                    actor_id=api["users"]["master"]
                    if close_role is ActorRole.MASTER
                    else api["users"]["executor"],
                    actor_role=close_role,
                    action="close",
                    from_status=WorkOrderStatus.AI_REVIEW,
                    to_status=WorkOrderStatus.CLOSED,
                    occurred_at=order.closed_at,
                    details={"submission_version": 2},
                )
            )
        return order


async def test_master_assistant_scoped_attention_repeat_and_history(api, database):
    now = datetime.now(UTC).replace(microsecond=0)
    machine = api["machines"][0]
    first = await _order(
        database,
        api,
        number="AST-1",
        status=WorkOrderStatus.ISSUED,
        issued_at=now - timedelta(days=2),
        equipment_id=machine.id,
        fault_id=api["fault"].id,
    )
    second = await _order(
        database,
        api,
        number="AST-2",
        status=WorkOrderStatus.ISSUED,
        issued_at=now - timedelta(days=3),
        equipment_id=machine.id,
        fault_id=api["fault"].id,
    )
    accepted = await _order(
        database,
        api,
        number="AST-CLOSED",
        status=WorkOrderStatus.CLOSED,
        issued_at=now - timedelta(days=5),
        equipment_id=machine.id,
        fault_id=api["fault"].id,
        closed=True,
    )
    headers = api["headers"]["master"]
    repeated = await api["client"].post(
        "/api/v1/master-assistant/answer",
        json={"question": "repeats", "topic": "repeated_faults", "equipment_id": str(machine.id)},
        headers=headers,
    )
    assert repeated.status_code == 200, repeated.text
    body = repeated.json()
    assert body["topic"] == "repeated_faults" and body["matching_orders"] == 3
    assert {item["order_id"] for item in body["citations"]} == {
        str(first.id),
        str(second.id),
        str(accepted.id),
    }
    history = await api["client"].post(
        "/api/v1/master-assistant/answer",
        json={
            "question": "history",
            "topic": "accepted_repair_history",
            "equipment_id": str(machine.id),
        },
        headers=headers,
    )
    assert history.status_code == 200
    assert history.json()["citations"][0]["order_id"] == str(accepted.id)
    attention = await api["client"].post(
        "/api/v1/master-assistant/answer",
        json={"question": "attention", "topic": "attention"},
        headers=headers,
    )
    assert attention.status_code == 200 and attention.json()["matching_orders"] >= 2


async def test_master_assistant_rejects_other_roles_and_clarifies_unknown_scope(api):
    for role in ("executor", "manager", "admin"):
        response = await api["client"].post(
            "/api/v1/master-assistant/answer",
            json={"question": "attention", "topic": "attention"},
            headers=api["headers"][role],
        )
        assert response.status_code == 403
    unclear = await api["client"].post(
        "/api/v1/master-assistant/answer",
        json={"question": "please help"},
        headers=api["headers"]["master"],
    )
    assert unclear.status_code == 200
    assert unclear.json()["answer_source"] == "clarification"
    assert unclear.json()["citations"] == []
    foreign = await api["client"].post(
        "/api/v1/master-assistant/answer",
        json={
            "question": "attention",
            "topic": "attention",
            "equipment_id": str(api["machines"][1].id),
        },
        headers=api["headers"]["master"],
    )
    assert foreign.status_code == 404


async def test_master_assistant_model_plan_is_grounded_and_safe_history_is_verified(api, database):
    now = datetime.now(UTC).replace(microsecond=0)
    machine = api["machines"][0]
    accepted = await _order(
        database,
        api,
        number="AST-SAFE",
        status=WorkOrderStatus.CLOSED,
        issued_at=now - timedelta(days=3),
        equipment_id=machine.id,
        fault_id=api["fault"].id,
        closed=True,
    )
    await _order(
        database,
        api,
        number="AST-UNSAFE",
        status=WorkOrderStatus.CLOSED,
        issued_at=now - timedelta(days=2),
        equipment_id=machine.id,
        fault_id=api["fault"].id,
        closed=True,
        close_role=ActorRole.EXECUTOR,
    )
    principal = Principal(
        employee_id=api["users"]["master"],
        session_id=uuid4(),
        login="master",
        display_name="master",
        role="master",
        area_ids=(api["areas"][0].id,),
    )
    config = OpenAIReviewConfig(
        api_key=None,
        model="gpt-5.4",
        reasoning_effort="low",
        request_timeout_seconds=1,
        total_timeout_seconds=1,
        max_output_tokens=2048,
    )

    async def invented_code(_question, _config):
        return AssistantIntent(
            topic="accepted_repair_history", equipment_code="FOREIGN-999", search_text=None
        )

    clarified = await master_assistant_answer(
        database,
        principal,
        AssistantQuestion(question="history for M0"),
        config,
        classifier=invented_code,
        now=now,
    )
    assert clarified.answer_source == "clarification" and clarified.citations == []

    async def invented_search(_question, _config):
        return AssistantIntent(
            topic="accepted_repair_history",
            equipment_code="M0",
            search_text="invented symptom",
        )

    selected_invented_search = await master_assistant_answer(
        database,
        principal,
        AssistantQuestion(question="history for M0", equipment_id=machine.id),
        config,
        classifier=invented_search,
        now=now,
    )
    assert selected_invented_search.answer_source == "clarification"
    assert selected_invented_search.citations == []

    async def grounded(_question, _config):
        return AssistantIntent(
            topic="accepted_repair_history", equipment_code="M0", search_text=None
        )

    history = await master_assistant_answer(
        database,
        principal,
        AssistantQuestion(question="history for M0"),
        config,
        classifier=grounded,
        now=now,
    )
    assert [citation.order_id for citation in history.citations] == [accepted.id]
    dated = await master_assistant_answer(
        database,
        principal,
        AssistantQuestion(question="history for M0 yesterday"),
        config,
        classifier=grounded,
        now=now,
    )
    assert dated.answer_source == "clarification" and dated.citations == []
    with pytest.raises(ValidationError):
        AssistantQuestion(question="bad\x00question")
