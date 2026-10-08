"""Transport, scope and read-model acceptance checks on real PostgreSQL."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from httpx2 import ASGITransport, AsyncClient
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import DBAPIError

from naryadai.app import create_app
from naryadai.application import orders as order_commands
from naryadai.application.orders import apply_review
from naryadai.auth.security import hash_secret
from naryadai.config import Settings
from naryadai.domain.lifecycle import ActorRole, AiAssessment, WorkOrderStatus
from naryadai.infrastructure.models import (
    AIReview,
    AIReviewJob,
    Area,
    Employee,
    EmployeeArea,
    Equipment,
    FaultCode,
    Material,
    OutboxEvent,
    Priority,
    TimeNorm,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def api(database, tmp_path):
    async with database.sessions.begin() as session:
        areas = [Area(code="MAIN", name="Main"), Area(code="OTHER", name="Other")]
        session.add_all(areas)
        await session.flush()
        users = {}
        hashed = hash_secret("test-secret")
        for login, role, index in [
            ("master", "master", 0),
            ("colleague", "master", 0),
            ("foreign", "master", 1),
            ("executor", "executor", 0),
            ("coworker", "executor", 0),
            ("manager", "manager", 0),
            ("admin", "admin", 0),
        ]:
            person = Employee(
                login=login,
                display_name=login,
                role=role,
                specialty="mechanic",
                grade=4,
                password_hash=hashed,
            )
            session.add(person)
            await session.flush()
            session.add(EmployeeArea(employee_id=person.id, area_id=areas[index].id))
            users[login] = person.id
        machines = [
            Equipment(
                inventory_number=f"M{i}",
                name=f"Pump{i}",
                area_id=a.id,
                equipment_type="pump",
                criticality=3,
            )
            for i, a in enumerate(areas)
        ]
        fault = FaultCode(code="F01", name="Leak", specialty="mechanic")
        material = Material(code="M01", name="Oil", unit="litre")
        session.add_all([*machines, fault, material])
        await session.flush()
    app = create_app(
        Settings(
            database_url=database.engine.url.render_as_string(hide_password=False),
            allowed_hosts=["testserver"],
            photo_root=tmp_path / "photos",
        )
    )
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app), base_url="http://testserver") as client,
    ):
        headers = {}
        for login in users:
            response = await client.post(
                "/api/v1/auth/login",
                json={
                    "login": login,
                    "secret": "test-secret",
                },
            )
            assert response.status_code == 200
            headers[login] = {"Authorization": "Bearer " + response.json()["access_token"]}
        yield {
            "client": client,
            "app": app,
            "headers": headers,
            "users": users,
            "areas": areas,
            "machines": machines,
            "fault": fault,
            "material": material,
        }


def create_body(api, **changes):
    return {
        "work_type": "unplanned",
        "description": "Repair pump leak",
        "area_id": str(api["areas"][0].id),
        "equipment_id": str(api["machines"][0].id),
        "executor_id": str(api["users"]["executor"]),
        "priority": "normal",
        "deadline": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
    } | changes


async def issue(api, body=None, key=None):
    response = await api["client"].post(
        "/api/v1/work-orders",
        json=body or create_body(api),
        headers=api["headers"]["master"] | {"Idempotency-Key": key or str(uuid4())},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def action(api, order, name, who="executor", key=None, **payload):
    return await api["client"].post(
        f"/api/v1/work-orders/{order['order_id']}/actions",
        json={"action": name, "expected_version": order["version"]} | payload,
        headers=api["headers"][who] | {"Idempotency-Key": key or str(uuid4())},
    )


async def test_http_identity_scope_and_atomic_issue(api, database):
    body = create_body(api)
    first = await issue(api, body, "same-issue-key")
    assert await issue(api, body, "same-issue-key") == first
    path = f"/api/v1/work-orders/{first['order_id']}"
    client = api["client"]
    assert (await client.get(path)).status_code == 401
    for role in ["master", "colleague", "executor", "manager"]:
        response = await client.get(path, headers=api["headers"][role])
        assert response.status_code == 200
        assert response.json()["number"].startswith("NR-")
    for role in ["coworker", "foreign"]:
        assert (await client.get(path, headers=api["headers"][role])).status_code == 404
    assert (await client.get(path, headers=api["headers"]["admin"])).status_code == 403
    assert (
        await action(api, first, "cancel", "colleague", reason="Wrong issuer")
    ).status_code == 403
    assert (await action(api, first, "cancel", "manager", reason="No rights")).status_code == 403
    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(WorkOrder)) == 1
        assert await session.scalar(select(func.count()).select_from(WorkOrderEvent)) == 1
        assert await session.scalar(select(func.count()).select_from(OutboxEvent)) == 1


async def test_transport_disallows_status_bypass_and_requires_idempotency(api):
    client, headers = api["client"], api["headers"]["master"]
    body = create_body(api)
    assert (await client.post("/api/v1/work-orders", json=body, headers=headers)).status_code == 422
    for change in [
        {"number": "CLIENT-NUMBER"},
        {"status": "closed"},
        {"deadline": "2026-10-10T12:00:00"},
        {"description": "  "},
    ]:
        response = await client.post(
            "/api/v1/work-orders",
            json=body | change,
            headers=headers | {"Idempotency-Key": str(uuid4())},
        )
        assert response.status_code == 422
    item = await issue(api)
    for name in ["record_ai_assessment", "start_ai_review", "mark_rework"]:
        assert (await action(api, item, name, "master")).status_code == 422
    path = f"/api/v1/work-orders/{item['order_id']}"
    assert (await client.patch(path, json={"status": "closed"}, headers=headers)).status_code == 405


async def test_reads_filters_pagination_counts_and_equipment_history(api, database):
    first = await issue(api)
    second = await issue(
        api,
        create_body(
            api,
            priority="emergency",
            work_type="planned",
            executor_id=str(api["users"]["coworker"]),
        ),
    )
    async with database.sessions.begin() as session:
        await session.execute(
            update(WorkOrder)
            .where(WorkOrder.id == UUID(first["order_id"]))
            .values(
                issued_at=datetime.now(UTC) - timedelta(days=2),
                deadline=datetime.now(UTC) - timedelta(days=1),
            )
        )
    client, headers = api["client"], api["headers"]["master"]
    page = (await client.get("/api/v1/work-orders?limit=1", headers=headers)).json()
    assert page["total"] == 2 and page["counts"]["issued"] == 2
    assert page["items"][0]["id"] == second["order_id"]
    for query in [
        "priority=normal",
        "work_type=unplanned",
        "overdue=true",
        "executor_id=" + str(api["users"]["executor"]),
        "area_id=" + str(api["areas"][0].id) + "&priority=normal",
    ]:
        data = (await client.get("/api/v1/work-orders?" + query, headers=headers)).json()
        assert data["total"] == 1 and data["items"][0]["id"] == first["order_id"]
    data = (await client.get("/api/v1/work-orders?overdue=false", headers=headers)).json()
    assert data["total"] == 1 and data["items"][0]["id"] == second["order_id"]
    path = f"/api/v1/equipment/{api['machines'][0].id}/history"
    assert (await client.get(path, headers=headers)).json()["total"] == 2
    assert (await client.get(path, headers=api["headers"]["executor"])).status_code == 403
    hidden = f"/api/v1/equipment/{api['machines'][1].id}/history"
    assert (await client.get(hidden, headers=headers)).status_code == 404
    assert (await client.get("/api/v1/work-orders?status=closed", headers=headers)).json()[
        "total"
    ] == 0
    own = (await client.get("/api/v1/work-orders", headers=api["headers"]["executor"])).json()
    assert own["total"] == 1
    assert (await client.get("/api/v1/work-orders?limit=201", headers=headers)).status_code == 422


async def test_work_order_sorts_before_pagination_with_stable_uuid_ties(api, database):
    now = datetime.now(UTC) + timedelta(days=3)
    first = await issue(api, create_body(api, priority="high"))
    second = await issue(api, create_body(api, priority="emergency"))
    third = await issue(api, create_body(api, priority="normal"))
    fourth = await issue(api, create_body(api, priority="normal"))
    async with database.sessions.begin() as session:
        await session.execute(
            update(WorkOrder)
            .where(WorkOrder.id == UUID(first["order_id"]))
            .values(issued_at=now, deadline=now + timedelta(hours=8))
        )
        await session.execute(
            update(WorkOrder)
            .where(WorkOrder.id == UUID(second["order_id"]))
            .values(issued_at=now + timedelta(hours=3), deadline=now + timedelta(hours=5))
        )
        for item in (third, fourth):
            await session.execute(
                update(WorkOrder)
                .where(WorkOrder.id == UUID(item["order_id"]))
                .values(issued_at=now + timedelta(hours=1), deadline=now + timedelta(hours=4))
            )

    tied_ids = sorted([third["order_id"], fourth["order_id"]])
    expected = {
        "priority": [second["order_id"], first["order_id"], *tied_ids],
        "deadline": [*tied_ids, second["order_id"], first["order_id"]],
        "newest": [second["order_id"], *tied_ids, first["order_id"]],
        "oldest": [first["order_id"], *tied_ids, second["order_id"]],
    }

    async def page_ids(sort: str | None) -> tuple[list[str], dict[str, object]]:
        params = {"limit": 2}
        if sort is not None:
            params["sort"] = sort
        first_page = await api["client"].get(
            "/api/v1/work-orders", params=params, headers=api["headers"]["master"]
        )
        assert first_page.status_code == 200, first_page.text
        params["offset"] = 2
        second_page = await api["client"].get(
            "/api/v1/work-orders", params=params, headers=api["headers"]["master"]
        )
        assert second_page.status_code == 200, second_page.text
        return (
            [item["id"] for item in first_page.json()["items"]]
            + [item["id"] for item in second_page.json()["items"]],
            first_page.json(),
        )

    default_ids, default_page = await page_ids(None)
    assert default_ids == expected["priority"]
    assert default_page["total"] == 4
    assert default_page["counts"]["issued"] == 4
    for sort, expected_ids in expected.items():
        ids, page = await page_ids(sort)
        assert ids == expected_ids
        assert page["total"] == 4
        assert page["counts"]["issued"] == 4
    assert (
        await api["client"].get(
            "/api/v1/work-orders", params={"sort": "invalid"}, headers=api["headers"]["master"]
        )
    ).status_code == 422


async def test_master_filter_and_scoped_master_options(api, database):
    client = api["client"]
    first = await issue(api)
    response = await client.post(
        "/api/v1/work-orders",
        json=create_body(api, priority="emergency", executor_id=str(api["users"]["coworker"])),
        headers=api["headers"]["colleague"] | {"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201, response.text
    second = response.json()
    response = await client.post(
        "/api/v1/work-orders",
        json=create_body(api, executor_id=str(api["users"]["coworker"])),
        headers=api["headers"]["colleague"] | {"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201, response.text
    third = response.json()
    response = await client.post(
        "/api/v1/work-orders",
        json=create_body(api, executor_id=str(api["users"]["executor"])),
        headers=api["headers"]["colleague"] | {"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201, response.text
    executor_colleague_order = response.json()
    async with database.sessions.begin() as session:
        colleague = await session.get(Employee, api["users"]["colleague"])
        assert colleague is not None
        colleague.is_active = False

    masters = await client.get("/api/v1/work-orders/masters", headers=api["headers"]["master"])
    assert masters.status_code == 200
    assert masters.json() == [
        {"id": str(api["users"]["colleague"]), "display_name": "colleague"},
        {"id": str(api["users"]["master"]), "display_name": "master"},
    ]
    executor_masters = await client.get(
        "/api/v1/work-orders/masters", headers=api["headers"]["executor"]
    )
    assert executor_masters.status_code == 200
    assert executor_masters.json() == [
        {"id": str(api["users"]["colleague"]), "display_name": "colleague"},
        {"id": str(api["users"]["master"]), "display_name": "master"},
    ]

    master_page = await client.get(
        "/api/v1/work-orders",
        params={"master_id": str(api["users"]["master"]), "limit": 1},
        headers=api["headers"]["manager"],
    )
    assert master_page.status_code == 200
    assert master_page.json()["total"] == 1
    assert master_page.json()["items"][0]["id"] == first["order_id"]
    assert master_page.json()["counts"]["issued"] == 1

    colleague_page = await client.get(
        "/api/v1/work-orders",
        params={"master_id": str(api["users"]["colleague"]), "attention": "true", "limit": 1},
        headers=api["headers"]["master"],
    )
    assert colleague_page.status_code == 200
    assert colleague_page.json()["total"] == 1
    assert colleague_page.json()["attention_count"] == 1
    assert colleague_page.json()["items"][0]["id"] == second["order_id"]
    colleague_all = await client.get(
        "/api/v1/work-orders",
        params={"master_id": str(api["users"]["colleague"]), "offset": 1, "limit": 1},
        headers=api["headers"]["master"],
    )
    assert colleague_all.status_code == 200
    assert colleague_all.json()["total"] == 3
    assert colleague_all.json()["counts"]["issued"] == 3
    assert colleague_all.json()["attention_count"] == 1
    assert colleague_all.json()["items"][0]["id"] == third["order_id"]

    assert (
        await client.get(
            "/api/v1/work-orders",
            params={"master_id": str(api["users"]["foreign"])},
            headers=api["headers"]["master"],
        )
    ).status_code == 404
    executor_page = await client.get(
        "/api/v1/work-orders",
        params={"master_id": str(api["users"]["colleague"])},
        headers=api["headers"]["executor"],
    )
    assert executor_page.status_code == 200
    assert executor_page.json()["total"] == 1
    assert executor_page.json()["items"][0]["id"] == executor_colleague_order["order_id"]
    for master_id in (api["users"]["foreign"], uuid4()):
        assert (
            await client.get(
                "/api/v1/work-orders",
                params={"master_id": str(master_id)},
                headers=api["headers"]["executor"],
            )
        ).status_code == 404


@pytest.mark.parametrize("reference", ["material", "fault"])
async def test_completion_serializes_with_reference_deletion(api, monkeypatch, reference):
    item = await issue(api)
    item = (await action(api, item, "accept")).json()
    item = (await action(api, item, "start")).json()
    locked = asyncio.Event()
    resume = asyncio.Event()
    verify_materials = order_commands._verify_materials

    async def pause_after_validation(session, completion):
        await verify_materials(session, completion)
        locked.set()
        await resume.wait()

    monkeypatch.setattr(order_commands, "_verify_materials", pause_after_validation)
    completion = asyncio.create_task(
        action(
            api,
            item,
            "complete",
            completion={
                "work_description": "Replaced seal and tested under operating pressure",
                "fault_code_id": str(api["fault"].id),
                "materials": [{"material_id": str(api["material"].id), "quantity": "1"}],
            },
        )
    )
    deletion = None
    try:
        await asyncio.wait_for(locked.wait(), timeout=5)
        collection = "materials" if reference == "material" else "fault-codes"
        deletion = asyncio.create_task(
            api["client"].delete(
                f"/api/v1/catalog/{collection}/{api[reference].id}",
                headers=api["headers"]["admin"],
            )
        )
        await asyncio.sleep(0.1)
        assert not deletion.done(), "Deletion must wait for the validated reference transaction"
    finally:
        resume.set()
        responses = await asyncio.wait_for(
            asyncio.gather(completion, *([deletion] if deletion else [])), timeout=5
        )
    assert responses[0].status_code == 200
    assert responses[1].status_code == 409
    assert responses[1].json()["detail"] == "reference_in_use"


async def test_workload_completion_materials_and_history_paging(api, database):
    client = api["client"]
    item = await issue(api)
    response = await action(api, item, "accept")
    assert response.status_code == 200, response.text
    item = response.json()
    response = await action(api, item, "start")
    assert response.status_code == 200, response.text
    item = response.json()
    view = (await client.get("/api/v1/workload", headers=api["headers"]["executor"])).json()
    assert len(view) == 1 and view[0]["availability"] == "busy"
    assert view[0]["area_ids"] == [str(api["areas"][0].id)]
    assert view[0]["current_order_id"] == item["order_id"]
    shift = await client.patch(
        f"/api/v1/catalog/employees/{api['users']['executor']}/access",
        json={"is_on_shift": False},
        headers=api["headers"]["admin"],
    )
    assert shift.status_code == 409
    complete = {
        "work_description": "Replaced seal and tested for leaks",
        "fault_code_id": str(api["fault"].id),
        "materials": [{"material_id": str(api["material"].id), "quantity": "0.125"}],
    }
    response = await action(api, item, "complete", key="one-submission", completion=complete)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "completed"
    assert (
        await action(api, item, "complete", key="one-submission", completion=complete)
    ).json() == response.json()
    detail = (
        await client.get(
            f"/api/v1/work-orders/{item['order_id']}", headers=api["headers"]["executor"]
        )
    ).json()
    assert detail["work_description"] == complete["work_description"]
    assert detail["master_name"] == "master"
    assert detail["executor_name"] == "executor"
    assert "password_hash" not in detail and "login" not in detail
    assert len(detail["materials"]) == 1
    assert detail["materials"][0]["quantity"] == "0.125"
    assert detail["materials"][0]["submission_version"] == detail["last_submission_version"]
    path = f"/api/v1/work-orders/{item['order_id']}/events"
    page = (await client.get(path + "?limit=2", headers=api["headers"]["master"])).json()
    assert [e["action"] for e in page["items"]] == ["issue", "accept"]
    assert page["next_after"] == 2
    rest = (await client.get(path + "?after_sequence=2", headers=api["headers"]["master"])).json()
    assert [e["action"] for e in rest["items"]] == ["start", "complete"]
    assert rest["next_after"] is None
    assert rest["items"][-1]["order_version"] == detail["version"]
    assert (await client.get("/api/v1/workload", headers=api["headers"]["executor"])).json()[0][
        "availability"
    ] == "free"
    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(OutboxEvent)) == 4


async def test_executor_read_models_redact_ai_and_internal_audit_data(api, database):
    item = await issue(api)
    order_id = UUID(item["order_id"])
    now = datetime.now(UTC)
    async with database.sessions.begin() as session:
        order = await session.get(WorkOrder, order_id)
        assert order is not None
        order.last_submission_version = 2
        session.add_all(
            [
                WorkOrderEvent(
                    work_order_id=order_id,
                    sequence=2,
                    order_version=2,
                    actor_id=api["users"]["executor"],
                    actor_role=ActorRole.EXECUTOR,
                    action="complete",
                    from_status=WorkOrderStatus.IN_PROGRESS,
                    to_status=WorkOrderStatus.COMPLETED,
                    occurred_at=now,
                    details={"attempt": 1},
                ),
                AIReview(
                    work_order_id=order_id,
                    order_version=2,
                    score=2,
                    explanation="Raw model explanation",
                    model_name="private-model-name",
                    needs_master_review=True,
                    master_score=5,
                    created_at=now,
                    report={
                        "provider": "private",
                        "provider_secret": "not for executor",
                        "checks": [
                            {
                                "title": "Время ремонта",
                                "detail": "Active time compared with the norm.",
                                "status": "warning",
                                "provider_trace": "private",
                            }
                        ],
                        "timing": {
                            "active_minutes": 45,
                            "paused_minutes": 5,
                            "elapsed_minutes": 50,
                            "norm_minutes": 30,
                        },
                    },
                ),
                AIReviewJob(
                    work_order_id=order_id,
                    submission_version=2,
                    status="retry",
                    attempts=2,
                    next_attempt_at=now,
                    last_error_code="provider_internal_error",
                ),
                WorkOrderEvent(
                    work_order_id=order_id,
                    sequence=3,
                    order_version=3,
                    actor_id=None,
                    actor_role=ActorRole.SYSTEM,
                    action="start_ai_review",
                    from_status=WorkOrderStatus.ISSUED,
                    to_status=WorkOrderStatus.AI_REVIEW,
                    occurred_at=now,
                    details={"model_name": "private-model-name"},
                ),
                WorkOrderEvent(
                    work_order_id=order_id,
                    sequence=4,
                    order_version=4,
                    actor_id=None,
                    actor_role=ActorRole.SYSTEM,
                    action="record_ai_assessment",
                    from_status=WorkOrderStatus.AI_REVIEW,
                    to_status=WorkOrderStatus.AI_REVIEW,
                    occurred_at=now,
                    details={"provider": "private", "score": 2},
                ),
                WorkOrderEvent(
                    work_order_id=order_id,
                    sequence=5,
                    order_version=5,
                    actor_id=api["users"]["master"],
                    actor_role=ActorRole.MASTER,
                    action="request_rework",
                    from_status=WorkOrderStatus.AI_REVIEW,
                    to_status=WorkOrderStatus.REWORK,
                    occurred_at=now,
                    reason="Repeat the inspection with photo evidence",
                    details={"ai_score": 2, "raw": "not for executor"},
                ),
                WorkOrderEvent(
                    work_order_id=order_id,
                    sequence=6,
                    order_version=6,
                    actor_id=api["users"]["master"],
                    actor_role=ActorRole.MASTER,
                    action="record_downtime",
                    from_status=WorkOrderStatus.REWORK,
                    to_status=WorkOrderStatus.REWORK,
                    occurred_at=now,
                    reason="Internal downtime assessment",
                    details={"started_at": "2026-01-01T00:00:00Z"},
                ),
                WorkOrderEvent(
                    work_order_id=order_id,
                    sequence=7,
                    order_version=7,
                    actor_id=api["users"]["master"],
                    actor_role=ActorRole.MASTER,
                    action="close",
                    from_status=WorkOrderStatus.AI_REVIEW,
                    to_status=WorkOrderStatus.CLOSED,
                    occurred_at=now,
                    reason="Accepted by the master after inspection",
                    details={"master_score": 5, "needs_master_review": True},
                ),
                WorkOrderEvent(
                    work_order_id=order_id,
                    sequence=8,
                    order_version=8,
                    actor_id=api["users"]["colleague"],
                    actor_role=ActorRole.MASTER,
                    action="comment",
                    from_status=WorkOrderStatus.CLOSED,
                    to_status=WorkOrderStatus.CLOSED,
                    occurred_at=now,
                    reason="Historical note",
                    details={"internal": "not for executor"},
                ),
            ]
        )
        colleague = await session.get(Employee, api["users"]["colleague"])
        assert colleague is not None
        colleague.display_name = "Deactivated colleague"
        colleague.is_active = False

    client = api["client"]
    path = f"/api/v1/work-orders/{order_id}"
    executor = (await client.get(path, headers=api["headers"]["executor"])).json()
    assert executor["reviews"] == []
    assert executor["ai_job"] is None
    assert len(executor["executor_feedback"]) == 1
    feedback = executor["executor_feedback"][0]
    assert datetime.fromisoformat(feedback.pop("reviewed_at").replace("Z", "+00:00")) == now
    assert feedback == {
        "submission_version": 2,
        "attempt": 1,
        "verdict": None,
        "score": 2,
        "master_score": 5,
        "effective_score": 5,
        "needs_master_review": True,
        "is_current": True,
        "recommendations": [
            {
                "title": "Время ремонта",
                "detail": "Active time compared with the norm.",
                "status": "warning",
            }
        ],
        "timing": {
            "active_minutes": 45.0,
            "paused_minutes": 5.0,
            "elapsed_minutes": 50.0,
            "norm_minutes": 30.0,
            "difference_minutes": 15.0,
            "percent_of_norm": 150.0,
        },
    }
    assert "model_name" not in feedback
    assert "report" not in feedback
    assert (await client.get(path, headers=api["headers"]["coworker"])).status_code == 404

    for role in ("master", "manager"):
        detail = (await client.get(path, headers=api["headers"][role])).json()
        assert detail["reviews"][0]["model_name"] == "private-model-name"
        assert detail["reviews"][0]["report"]["provider"] == "private"
        assert detail["ai_job"]["last_error_code"] == "provider_internal_error"

    events_path = path + "/events"
    first = await client.get(events_path + "?limit=1", headers=api["headers"]["executor"])
    assert first.status_code == 200
    assert [event["sequence"] for event in first.json()["items"]] == [1]
    assert first.json()["next_after"] == 1
    rework = await client.get(
        events_path + "?after_sequence=2&limit=1", headers=api["headers"]["executor"]
    )
    assert [event["sequence"] for event in rework.json()["items"]] == [5]
    assert rework.json()["items"][0]["reason"] == "Repeat the inspection with photo evidence"
    assert rework.json()["items"][0]["details"] == {}
    assert rework.json()["next_after"] == 5
    closing = await client.get(
        events_path + "?after_sequence=5", headers=api["headers"]["executor"]
    )
    assert [event["sequence"] for event in closing.json()["items"]] == [7, 8]
    assert closing.json()["items"][0]["reason"] == "Accepted by the master after inspection"
    assert closing.json()["items"][0]["details"] == {}
    assert closing.json()["next_after"] is None
    assert closing.json()["items"][1]["actor_display_name"] == "Deactivated colleague"

    master_events = (await client.get(events_path, headers=api["headers"]["master"])).json()[
        "items"
    ]
    assert [event["sequence"] for event in master_events] == [1, 2, 3, 4, 5, 6, 7, 8]
    assert master_events[2]["details"]["model_name"] == "private-model-name"
    assert master_events[0]["actor_display_name"] == "master"
    assert master_events[2]["actor_display_name"] == "Система"
    assert master_events[-1]["actor_display_name"] == "Deactivated colleague"


async def test_executor_feedback_keeps_rework_history_and_master_override_current(api, database):
    first = await issue(api)
    accepted = await action(api, first, "accept")
    started = await action(api, accepted.json(), "start")
    completed = await action(
        api,
        started.json(),
        "complete",
        completion={
            "work_description": "Replaced the seal and pressure-tested the pump.",
            "fault_code_id": str(api["fault"].id),
            "no_materials_reason": "No material was required.",
        },
    )
    assert completed.status_code == 200
    first_review = await apply_review(
        database,
        UUID(first["order_id"]),
        expected_order_version=completed.json()["version"],
        submission_version=completed.json()["version"],
        verdict=AiAssessment.ACCEPTED,
        needs_master_review=False,
        score=2,
        explanation="First submission needs a clearer result.",
        model_name="internal-review-model",
        report={"checks": [], "timing": {"active_minutes": 10, "norm_minutes": 20}},
    )
    rework = await action(
        api,
        first_review,
        "request_rework",
        "master",
        reason="Please attach a clearer after photo.",
    )
    assert rework.status_code == 200
    restarted = await action(api, rework.json(), "start")
    second_completion = await action(
        api,
        restarted.json(),
        "complete",
        completion={
            "work_description": "Added a clearer photo and repeated the pressure test.",
            "fault_code_id": str(api["fault"].id),
            "no_materials_reason": "No additional material was required.",
        },
    )
    assert second_completion.status_code == 200
    second_review = await apply_review(
        database,
        UUID(first["order_id"]),
        expected_order_version=second_completion.json()["version"],
        submission_version=second_completion.json()["version"],
        verdict=None,
        needs_master_review=True,
        score=None,
        explanation="Master inspection is required.",
        model_name="internal-review-model",
        report={"checks": [], "timing": {"active_minutes": 25, "norm_minutes": 20}},
    )
    closed = await action(
        api,
        second_review,
        "override_close",
        "master",
        reason="Master inspected the completed repair.",
        master_score=5,
    )
    assert closed.status_code == 200

    detail = (
        await api["client"].get(
            f"/api/v1/work-orders/{first['order_id']}", headers=api["headers"]["executor"]
        )
    ).json()
    assert detail["reviews"] == [] and detail["ai_job"] is None
    history = detail["executor_feedback"]
    assert [(entry["attempt"], entry["is_current"]) for entry in history] == [
        (1, False),
        (2, True),
    ]
    assert history[0]["score"] == history[0]["effective_score"] == 2
    assert history[1]["score"] is None
    assert history[1]["master_score"] == history[1]["effective_score"] == 5


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE work_order_events SET action='tamper'",
        "DELETE FROM work_order_events",
    ],
)
async def test_audit_is_immutable_even_through_database(api, database, statement):
    await issue(api)
    async with database.sessions() as session:
        with pytest.raises(DBAPIError, match="append-only"):
            await session.execute(text(statement))
        await session.rollback()
        assert await session.scalar(select(func.count()).select_from(WorkOrderEvent)) == 1


async def test_workload_offshift_and_invalid_area(api, database):
    async with database.sessions.begin() as session:
        await session.execute(
            update(Employee)
            .where(Employee.id == api["users"]["executor"])
            .values(
                is_on_shift=False,
            )
        )
    client = api["client"]
    result = await client.get("/api/v1/workload", headers=api["headers"]["executor"])
    assert result.json()[0]["availability"] == "off_shift"
    response = await client.get(
        "/api/v1/workload?area_id=" + str(api["areas"][1].id),
        headers=api["headers"]["master"],
    )
    assert response.status_code == 404


async def test_search_precedes_pagination_and_preserves_scope(api):
    client, headers = api["client"], api["headers"]["master"]
    first = await issue(api, create_body(api, description="Hydraulic seal inspection"))
    second = await issue(
        api,
        create_body(
            api,
            description="Hydraulic pump inspection",
            priority="emergency",
            executor_id=str(api["users"]["coworker"]),
        ),
    )
    await issue(api, create_body(api, description="Unrelated bearing replacement"))
    page = (
        await client.get(
            "/api/v1/work-orders",
            params={"q": " HYDRAULIC ", "limit": 1},
            headers=headers,
        )
    ).json()
    assert page["total"] == 2 and page["counts"]["issued"] == 2
    assert page["items"][0]["id"] == second["order_id"]
    next_page = (
        await client.get(
            "/api/v1/work-orders",
            params={"q": "hydraulic", "limit": 1, "offset": 1},
            headers=headers,
        )
    ).json()
    assert next_page["items"][0]["id"] == first["order_id"]
    own = (
        await client.get(
            "/api/v1/work-orders",
            params={"q": "hydraulic"},
            headers=api["headers"]["executor"],
        )
    ).json()
    assert own["total"] == 1 and own["items"][0]["id"] == first["order_id"]
    foreign = (
        await client.get(
            "/api/v1/work-orders",
            params={"q": "hydraulic"},
            headers=api["headers"]["foreign"],
        )
    ).json()
    assert foreign["total"] == 0 and sum(foreign["counts"].values()) == 0


async def test_search_number_equipment_and_literal_wildcards(api):
    created = await issue(api, create_body(api, description="Inspect 50%_capacity seal"))
    await issue(api, create_body(api, description="Inspect all remaining seals"))
    client, headers = api["client"], api["headers"]["master"]
    detail = (
        await client.get(
            f"/api/v1/work-orders/{created['order_id']}",
            headers=headers,
        )
    ).json()
    for query, expected in [("pump0", 2), ("m0", 2), ("%_", 1), (detail["number"], 1)]:
        response = await client.get("/api/v1/work-orders", params={"q": query}, headers=headers)
        assert response.status_code == 200
        assert response.json()["total"] == expected
    assert (
        await client.get(
            "/api/v1/work-orders",
            params={"q": "x" * 121},
            headers=headers,
        )
    ).status_code == 422


async def test_attention_filter_counts_all_pages_without_archived_or_foreign_orders(api, database):
    first = await issue(api, create_body(api, priority="high"))
    second = await issue(api, create_body(api, priority="emergency"))
    late = await issue(api)
    await issue(api)
    archived = await issue(api, create_body(api, priority="emergency"))
    assert (
        await action(api, archived, "cancel", "master", reason="Duplicate request")
    ).status_code == 200
    async with database.sessions.begin() as session:
        await session.execute(
            update(WorkOrder)
            .where(WorkOrder.id == UUID(late["order_id"]))
            .values(
                issued_at=datetime.now(UTC) - timedelta(hours=2),
                deadline=datetime.now(UTC) - timedelta(hours=1),
            )
        )
    client, headers = api["client"], api["headers"]["master"]
    all_orders = (await client.get("/api/v1/work-orders", headers=headers)).json()
    assert all_orders["total"] == 5 and all_orders["attention_count"] == 3
    found = []
    for offset in range(3):
        page = (
            await client.get(
                "/api/v1/work-orders",
                params={"attention": "true", "limit": 1, "offset": offset},
                headers=headers,
            )
        ).json()
        assert page["total"] == page["attention_count"] == page["counts"]["issued"] == 3
        found.append(page["items"][0]["id"])
    assert set(found) == {first["order_id"], second["order_id"], late["order_id"]}
    hidden = (
        await client.get(
            "/api/v1/work-orders",
            params={"attention": "true"},
            headers=api["headers"]["foreign"],
        )
    ).json()
    assert hidden["total"] == hidden["attention_count"] == 0


async def test_suggestions_are_scoped_explainable_and_read_only(api, database):
    now = datetime.now(UTC)
    async with database.sessions.begin() as session:
        leak = FaultCode(code="HYD001", name="Утечка масла", specialty="mechanic")
        electric = FaultCode(code="ELEC001", name="Перегрев двигателя", specialty="electrician")
        session.add_all((leak, electric))
        await session.flush()
        session.add_all(
            (
                TimeNorm(fault_code_id=leak.id, equipment_type="pump", minutes=37),
                TimeNorm(fault_code_id=electric.id, equipment_type="pump", minutes=55),
            )
        )
        for existing in (api["users"]["executor"], api["users"]["coworker"]):
            employee = await session.get(Employee, existing)
            assert employee is not None
            employee.is_on_shift = False
        candidates = []
        for login, name, specialty in (
            ("rank-alpha", "Альфа", "mechanic"),
            ("rank-beta", "Бета", "mechanic"),
            ("rank-gamma", "Гамма", "mechanic"),
            ("rank-electric", "Электрик", "electrician"),
        ):
            employee = Employee(
                login=login,
                display_name=name,
                role="executor",
                specialty=specialty,
                grade=4,
                password_hash="x",
            )
            session.add(employee)
            await session.flush()
            session.add(EmployeeArea(employee_id=employee.id, area_id=api["areas"][0].id))
            candidates.append(employee)
        await session.flush()

        sequence = 0
        for candidate, score in zip(candidates[:3], (5, 3, 4), strict=True):
            for number in range(3):
                closed_at = now - timedelta(days=number + 1)
                order = WorkOrder(
                    number=f"SUG-{candidate.login}-{number}",
                    work_type=WorkType.UNPLANNED,
                    description="Historical quality",
                    area_id=api["areas"][0].id,
                    equipment_id=api["machines"][0].id,
                    # The first worker proves attribution comes from completion,
                    # not the mutable current executor field.
                    executor_id=(
                        api["users"]["coworker"] if candidate is candidates[0] else candidate.id
                    ),
                    master_id=api["users"]["master"],
                    priority=Priority.NORMAL,
                    status=WorkOrderStatus.CLOSED,
                    issued_at=closed_at - timedelta(hours=2),
                    deadline=closed_at - timedelta(hours=1),
                    started_at=closed_at - timedelta(hours=1, minutes=30),
                    completed_at=closed_at - timedelta(minutes=30),
                    closed_at=closed_at,
                    fault_code_id=leak.id,
                    version=2,
                    attempt=1,
                    last_submission_version=1,
                )
                session.add(order)
                await session.flush()
                review = AIReview(
                    work_order_id=order.id,
                    order_version=1,
                    score=score,
                    master_score=score if number == 0 else None,
                    needs_master_review=False,
                    explanation="Closed history",
                    model_name="test",
                    created_at=closed_at,
                )
                session.add(review)
                await session.flush()
                sequence += 1
                session.add(
                    WorkOrderEvent(
                        work_order_id=order.id,
                        sequence=1,
                        order_version=1,
                        actor_id=candidate.id,
                        actor_role=ActorRole.EXECUTOR,
                        action="complete",
                        from_status=WorkOrderStatus.IN_PROGRESS,
                        to_status=WorkOrderStatus.COMPLETED,
                        occurred_at=closed_at - timedelta(minutes=30),
                        details={"submission_version": 1},
                    )
                )
                session.add(
                    WorkOrderEvent(
                        work_order_id=order.id,
                        sequence=2,
                        order_version=2,
                        actor_id=api["users"]["master"],
                        actor_role=ActorRole.MASTER,
                        action="close",
                        from_status=WorkOrderStatus.AI_REVIEW,
                        to_status=WorkOrderStatus.CLOSED,
                        occurred_at=closed_at,
                        details={"review_id": str(review.id), "submission_version": 1},
                    )
                )
        await session.flush()
        before = await session.scalar(select(func.count()).select_from(WorkOrderEvent))

    body = {
        "area_id": str(api["areas"][0].id),
        "equipment_id": str(api["machines"][0].id),
        "description": "сильно подтекает масло",
        "fault_code_id": str(leak.id),
    }
    response = await api["client"].post(
        "/api/v1/work-orders/suggestions", json=body, headers=api["headers"]["master"]
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["selected_norm_minutes"] == 37 and data["required_specialty"] == "mechanic"
    assert data["faults"] == [
        {
            "fault_code_id": str(leak.id),
            "code": "HYD001",
            "name": "Утечка масла",
            "specialty": "mechanic",
            "reasons": ["Шифр неисправности выбран мастером."],
            "norm_minutes": 37,
        }
    ]
    assert [row["display_name"] for row in data["executors"]] == ["Альфа", "Гамма", "Бета"]
    assert (
        data["executors"][0]["quality_score"] == 5
        and data["executors"][0]["quality_sample_count"] == 3
    )
    assert all(row["specialty"] == "mechanic" for row in data["executors"])
    async with database.sessions.begin() as session:
        assert await session.scalar(select(func.count()).select_from(WorkOrderEvent)) == before
        alpha_review = await session.scalar(
            select(AIReview)
            .join(WorkOrder, WorkOrder.id == AIReview.work_order_id)
            .where(WorkOrder.number == "SUG-rank-alpha-0")
        )
        assert alpha_review is not None
        alpha_review.master_score = 1

    master_preferred = await api["client"].post(
        "/api/v1/work-orders/suggestions", json=body, headers=api["headers"]["master"]
    )
    assert [row["display_name"] for row in master_preferred.json()["executors"]] == [
        "Гамма",
        "Альфа",
        "Бета",
    ]
    assert master_preferred.json()["executors"][1]["quality_score"] == 3.67
    async with database.sessions.begin() as session:
        novice = Employee(
            login="rank-newcomer",
            display_name="А новичок",  # noqa: RUF001
            role="executor",
            specialty="mechanic",
            grade=3,
            password_hash="x",
        )
        session.add(novice)
        await session.flush()
        session.add(EmployeeArea(employee_id=novice.id, area_id=api["areas"][0].id))
    neutral = await api["client"].post(
        "/api/v1/work-orders/suggestions", json=body, headers=api["headers"]["master"]
    )
    assert neutral.json()["executors"][0]["display_name"] == "А новичок"  # noqa: RUF001
    assert neutral.json()["executors"][0]["quality_score"] is None
    assert neutral.json()["executors"][0]["quality_sample_count"] == 0
    assert any("качество не меняло порядок" in note for note in neutral.json()["notes"])

    by_text = await api["client"].post(
        "/api/v1/work-orders/suggestions",
        json=body | {"fault_code_id": None, "description": "перегрелся двигатель"},
        headers=api["headers"]["master"],
    )
    assert by_text.status_code == 200
    assert by_text.json()["faults"][0]["code"] == "ELEC001"
    assert by_text.json()["required_specialty"] is None
    unknown = await api["client"].post(
        "/api/v1/work-orders/suggestions",
        json=body | {"fault_code_id": None, "description": "квантовый арбуз"},
        headers=api["headers"]["master"],
    )
    assert unknown.status_code == 200 and unknown.json()["faults"] == []
    for role in ("executor", "manager", "admin"):
        assert (
            await api["client"].post(
                "/api/v1/work-orders/suggestions", json=body, headers=api["headers"][role]
            )
        ).status_code == 403
    assert (
        await api["client"].post(
            "/api/v1/work-orders/suggestions", json=body, headers=api["headers"]["foreign"]
        )
    ).status_code == 404
    assert (
        await api["client"].post(
            "/api/v1/work-orders/suggestions",
            json=body | {"equipment_id": str(api["machines"][1].id)},
            headers=api["headers"]["master"],
        )
    ).status_code == 404
    assert (
        await api["client"].post(
            "/api/v1/work-orders/suggestions",
            json=body | {"fault_code_id": str(uuid4())},
            headers=api["headers"]["master"],
        )
    ).status_code == 404


async def test_suggestions_do_not_mark_cross_area_worker_free(api, database):
    now = datetime.now(UTC)
    async with database.sessions.begin() as session:
        off_shift = await session.get(Employee, api["users"]["executor"])
        assert off_shift is not None
        off_shift.is_on_shift = False
        no_match = FaultCode(
            code="ELEC-NO-MATCH", name="Перегрев двигателя", specialty="electrician"
        )
        session.add_all(
            (
                no_match,
                TimeNorm(fault_code_id=api["fault"].id, equipment_type="crusher", minutes=12),
            )
        )
        foreign_job = WorkOrder(
            number="SUG-FOREIGN-BUSY",
            work_type=WorkType.UNPLANNED,
            description="Other area work",
            area_id=api["areas"][1].id,
            equipment_id=api["machines"][1].id,
            executor_id=api["users"]["coworker"],
            master_id=api["users"]["foreign"],
            priority=Priority.NORMAL,
            status=WorkOrderStatus.IN_PROGRESS,
            issued_at=now - timedelta(minutes=20),
            deadline=now + timedelta(hours=2),
            started_at=now - timedelta(minutes=10),
            version=1,
            attempt=1,
        )
        session.add(foreign_job)
    response = await api["client"].post(
        "/api/v1/work-orders/suggestions",
        json={
            "area_id": str(api["areas"][0].id),
            "equipment_id": str(api["machines"][0].id),
            "description": "leak",
            "fault_code_id": str(api["fault"].id),
        },
        headers=api["headers"]["master"],
    )
    assert response.status_code == 200, response.text
    coworker = next(
        row
        for row in response.json()["executors"]
        if row["employee_id"] == str(api["users"]["coworker"])
    )
    assert coworker["availability"] == "busy"
    assert "других участков" in " ".join(coworker["reasons"])
    assert response.json()["selected_norm_minutes"] is None
    assert str(api["users"]["executor"]) not in {
        row["employee_id"] for row in response.json()["executors"]
    }
    no_specialist = await api["client"].post(
        "/api/v1/work-orders/suggestions",
        json={
            "area_id": str(api["areas"][0].id),
            "equipment_id": str(api["machines"][0].id),
            "description": "перегрев",
            "fault_code_id": str(no_match.id),
        },
        headers=api["headers"]["master"],
    )
    assert no_specialist.status_code == 200
    assert no_specialist.json()["executors"] == []
    assert no_specialist.json()["selected_norm_minutes"] is None
