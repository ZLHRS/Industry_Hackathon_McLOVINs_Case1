"""Preventive orders are reproducible analytics signals, never saved drafts."""

from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from httpx2 import ASGITransport, AsyncClient
from sqlalchemy import func, select

from naryadai.analytics.contracts import AnalyticsQuery
from naryadai.analytics.service import build_report
from naryadai.app import create_app
from naryadai.application.common import OperationError, _request_hash
from naryadai.application.contracts import CreateOrder, PreventionSource
from naryadai.application.orders import create_order
from naryadai.application.prevention import prepare_preventive_draft
from naryadai.auth.dependencies import Principal
from naryadai.auth.security import hash_secret
from naryadai.config import Settings
from naryadai.domain.lifecycle import WorkOrderStatus
from naryadai.infrastructure.models import (
    Area,
    Employee,
    EmployeeArea,
    Equipment,
    FaultCode,
    IdempotencyRecord,
    Priority,
    WorkOrder,
    WorkOrderEvent,
    WorkType,
)

pytestmark = pytest.mark.asyncio


async def _fixture(database) -> dict[str, object]:
    now = datetime.now(UTC).replace(microsecond=0)
    async with database.sessions.begin() as session:
        area = Area(code="PREV-A", name="Prevention area")
        foreign_area = Area(code="PREV-X", name="Foreign area")
        master = Employee(
            login="prevention-master",
            display_name="Prevention master",
            role="master",
            specialty="maintenance",
            grade=5,
            password_hash=hash_secret("prevention-secret"),
        )
        executor = Employee(
            login="prevention-executor",
            display_name="Prevention executor",
            role="executor",
            specialty="mechanic",
            grade=4,
            password_hash=hash_secret("prevention-secret"),
        )
        manager = Employee(
            login="prevention-manager",
            display_name="Prevention manager",
            role="manager",
            specialty="maintenance",
            grade=5,
            password_hash=hash_secret("prevention-secret"),
        )
        session.add_all((area, foreign_area, master, executor, manager))
        await session.flush()
        session.add_all(
            (
                EmployeeArea(employee_id=master.id, area_id=area.id),
                EmployeeArea(employee_id=executor.id, area_id=area.id),
                EmployeeArea(employee_id=manager.id, area_id=area.id),
            )
        )
        recurring_equipment = Equipment(
            inventory_number="PREV-R", name="Recurring pump", area_id=area.id,
            equipment_type="pump", criticality=4,
        )
        ppr_equipment = Equipment(
            inventory_number="PREV-P", name="PPR pump", area_id=area.id,
            equipment_type="pump", criticality=3,
        )
        foreign_equipment = Equipment(
            inventory_number="PREV-X", name="Foreign pump", area_id=foreign_area.id,
            equipment_type="pump", criticality=3,
        )
        fault = FaultCode(code="PREV-F", name="Seal wear", specialty="mechanic")
        session.add_all((recurring_equipment, ppr_equipment, foreign_equipment, fault))
        await session.flush()

        def order(
            number: str,
            equipment: Equipment,
            work_type: WorkType,
            issued_days_ago: int,
            completed_days_ago: int,
        ) -> WorkOrder:
            issued_at = now - timedelta(days=issued_days_ago)
            return WorkOrder(
                number=number,
                work_type=work_type,
                description=number,
                area_id=area.id,
                equipment_id=equipment.id,
                executor_id=executor.id,
                master_id=master.id,
                priority=Priority.HIGH,
                status=WorkOrderStatus.COMPLETED,
                issued_at=issued_at,
                deadline=issued_at + timedelta(hours=12),
                started_at=issued_at + timedelta(minutes=10),
                completed_at=now - timedelta(days=completed_days_ago),
                fault_code_id=fault.id if work_type is WorkType.UNPLANNED else None,
                version=1,
                attempt=1,
            )

        session.add_all(
            (
                order("PREV-R1", recurring_equipment, WorkType.UNPLANNED, 7, 6),
                order("PREV-R2", recurring_equipment, WorkType.UNPLANNED, 5, 4),
                order("PREV-P1", ppr_equipment, WorkType.PLANNED, 7, 6),
                order("PREV-P2", ppr_equipment, WorkType.UNPLANNED, 5, 4),
            )
        )

    def principal(employee: Employee, area_ids: tuple[UUID, ...]) -> Principal:
        return Principal(
            employee_id=employee.id,
            session_id=uuid4(),
            login=employee.login,
            display_name=employee.display_name,
            role=str(employee.role),
            area_ids=area_ids,
        )

    return {
        "area": area.id,
        "master": principal(master, (area.id,)),
        "executor": principal(executor, (area.id,)),
        "manager": Principal(
            employee_id=manager.id,
            session_id=uuid4(),
            login="prevention-manager",
            display_name="Prevention manager",
            role="manager",
            area_ids=(area.id,),
        ),
        "master_login": master.login,
        "executor_login": executor.login,
        "manager_login": manager.login,
        "executor_id": executor.id,
        "recurring_equipment": recurring_equipment.id,
        "ppr_equipment": ppr_equipment.id,
        "foreign_equipment": foreign_equipment.id,
        "fault": fault.id,
        "now": now,
    }


@asynccontextmanager
async def _client(database, tmp_path):
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
        yield client


async def _headers(client: AsyncClient, login: str) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/login", json={"login": login, "secret": "prevention-secret"}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def _query(now: datetime) -> AnalyticsQuery:
    return AnalyticsQuery(
        period="custom",
        **{"from": now - timedelta(days=8), "to": now},
        timezone="UTC",
    )


async def _source(database, data: dict[str, object], family: str) -> PreventionSource:
    query = _query(data["now"])  # type: ignore[arg-type]
    report = await build_report(database, data["master"], query)  # type: ignore[arg-type]
    equipment_id = (
        data["recurring_equipment"] if family == "recurring_fault" else data["ppr_equipment"]
    )
    anomaly = next(
        row
        for row in report.anomalies
        if row.family == family and row.evidence["equipment_id"] == str(equipment_id)
    )
    return PreventionSource(
        query=query,
        family=family,  # type: ignore[arg-type]
        equipment_id=equipment_id,  # type: ignore[arg-type]
        order_ids=tuple(  # type: ignore[arg-type]
            UUID(value) for value in anomaly.evidence["order_ids"]
        ),
    )


def _create_body(data: dict[str, object], source: PreventionSource, **changes) -> CreateOrder:
    return CreateOrder(
        work_type=WorkType.PLANNED,
        description="Мастер уточнил объём контрольной профилактики.",
        area_id=data["area"],  # type: ignore[arg-type]
        equipment_id=source.equipment_id,
        executor_id=data["executor_id"],  # type: ignore[arg-type]
        priority=Priority.PLANNED,
        deadline=datetime.now(UTC) + timedelta(days=2),
        prevention_source=source,
    ).model_copy(update=changes)


async def test_preventive_draft_is_read_only_and_confirmed_order_has_audit_lineage(
    database,
) -> None:
    data = await _fixture(database)
    source = await _source(database, data, "recurring_fault")
    async with database.sessions() as session:
        before_orders = await session.scalar(select(func.count()).select_from(WorkOrder))
        before_events = await session.scalar(select(func.count()).select_from(WorkOrderEvent))

    draft = await prepare_preventive_draft(
        database, data["master"], source  # type: ignore[arg-type]
    )
    assert draft.equipment_id == data["recurring_equipment"]
    assert draft.fault_code_id == data["fault"]
    assert draft.title.startswith("Recurring pump:")
    assert len(draft.evidence_orders) == 2

    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(WorkOrder)) == before_orders
        assert (
            await session.scalar(select(func.count()).select_from(WorkOrderEvent)) == before_events
        )

    body = _create_body(data, source, fault_code_id=None)
    created = await create_order(
        database, data["master"], body, "prevention-create-key"  # type: ignore[arg-type]
    )
    order_id = UUID(created["order_id"])
    async with database.sessions() as session:
        order = await session.get(WorkOrder, order_id)
        event = await session.scalar(
            select(WorkOrderEvent).where(WorkOrderEvent.work_order_id == order_id)
        )
        assert (
            order is not None
            and order.description == body.description
            and order.fault_code_id is None
        )
        assert event is not None
        lineage = event.details["prevention_source"]
        assert lineage["order_ids"] == [str(value) for value in source.order_ids]
        assert lineage["title"] == draft.title
        assert lineage["recommendation"] == draft.description
        assert lineage["formula"]
        assert datetime.fromisoformat(lineage["period"]["from"]) == source.query.from_
        assert [item["number"] for item in lineage["evidence_orders"]] == [
            item.number for item in draft.evidence_orders
        ]

    async with database.sessions.begin() as session:
        equipment = await session.get(Equipment, draft.equipment_id)
        assert equipment is not None
        equipment.is_active = False
    replay = await create_order(
        database, data["master"], body, "prevention-create-key"  # type: ignore[arg-type]
    )
    assert replay == created


async def test_preventive_create_rejects_mismatch_and_stale_source_without_new_order(
    database,
) -> None:
    data = await _fixture(database)
    source = await _source(database, data, "after_ppr")
    async with database.sessions() as session:
        before = await session.scalar(select(func.count()).select_from(WorkOrder))

    with pytest.raises(OperationError, match="prevention_order_must_be_planned"):
        await create_order(
            database,
            data["master"],  # type: ignore[arg-type]
            _create_body(data, source, work_type=WorkType.UNPLANNED),
            "prevention-not-planned",
        )
    with pytest.raises(OperationError, match="prevention_equipment_mismatch"):
        await create_order(
            database,
            data["master"],  # type: ignore[arg-type]
            _create_body(data, source, equipment_id=data["recurring_equipment"]),
            "prevention-wrong-equipment",
        )

    async with database.sessions.begin() as session:
        order = await session.scalar(
            select(WorkOrder).where(
                WorkOrder.id.in_(source.order_ids), WorkOrder.work_type == WorkType.UNPLANNED
            )
        )
        assert order is not None
        order.work_type = WorkType.PLANNED
    with pytest.raises(OperationError, match="prevention_source_stale"):
        await create_order(
            database,
            data["master"],  # type: ignore[arg-type]
            _create_body(data, source),
            "prevention-stale-source",
        )
    async with database.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(WorkOrder)) == before


async def test_preventive_sources_reject_wrong_role_foreign_tampered_stale_and_inactive(
    database,
) -> None:
    data = await _fixture(database)
    source = await _source(database, data, "after_ppr")
    after_ppr = await prepare_preventive_draft(
        database, data["master"], source  # type: ignore[arg-type]
    )
    assert after_ppr.equipment_id == data["ppr_equipment"]
    assert after_ppr.fault_code_id is None
    assert len(after_ppr.evidence_orders) == 2

    with pytest.raises(OperationError, match="role_not_permitted"):
        await prepare_preventive_draft(database, data["executor"], source)  # type: ignore[arg-type]

    foreign = source.model_copy(update={"equipment_id": data["foreign_equipment"]})
    with pytest.raises(OperationError, match="prevention_equipment_not_found"):
        await prepare_preventive_draft(database, data["master"], foreign)  # type: ignore[arg-type]

    tampered = source.model_copy(update={"order_ids": (*source.order_ids[:-1], uuid4())})
    with pytest.raises(OperationError, match="prevention_source_stale"):
        await prepare_preventive_draft(database, data["master"], tampered)  # type: ignore[arg-type]

    stale = source.model_copy(update={"family": "recurring_fault"})
    with pytest.raises(OperationError, match="prevention_source_stale"):
        await prepare_preventive_draft(database, data["master"], stale)  # type: ignore[arg-type]

    async with database.sessions.begin() as session:
        equipment = await session.get(Equipment, source.equipment_id)
        assert equipment is not None
        equipment.is_active = False
    with pytest.raises(OperationError, match="equipment_inactive"):
        await prepare_preventive_draft(database, data["master"], source)  # type: ignore[arg-type]


async def test_preventive_draft_http_uses_canonical_aliases_and_master_role(
    database, tmp_path
) -> None:
    data = await _fixture(database)
    source = await _source(database, data, "after_ppr")
    payload = source.model_dump(mode="json", by_alias=True)
    assert "from" in payload["query"] and "from_" not in payload["query"]
    async with _client(database, tmp_path) as client:
        master = await _headers(client, data["master_login"])  # type: ignore[arg-type]
        executor = await _headers(client, data["executor_login"])  # type: ignore[arg-type]
        manager = await _headers(client, data["manager_login"])  # type: ignore[arg-type]
        prepared = await client.post(
            "/api/v1/analytics/preventive-draft", json=payload, headers=master
        )
        assert prepared.status_code == 200, prepared.text
        response = prepared.json()
        assert response["source"]["query"]["from"] == payload["query"]["from"]
        assert "from_" not in response["source"]["query"]
        assert [item["number"] for item in response["evidence_orders"]]
        assert (
            await client.post(
                "/api/v1/analytics/preventive-draft", json=payload, headers=executor
            )
        ).status_code == 403
        assert (
            await client.post(
                "/api/v1/analytics/preventive-draft", json=payload, headers=manager
            )
        ).status_code == 403

    with pytest.raises(OperationError, match="role_not_permitted"):
        await prepare_preventive_draft(database, data["manager"], source)  # type: ignore[arg-type]


async def test_ordinary_create_keeps_legacy_idempotency_hash(database) -> None:
    data = await _fixture(database)
    body = CreateOrder(
        work_type=WorkType.UNPLANNED,
        description="Обычный наряд без превентивного источника.",
        area_id=data["area"],  # type: ignore[arg-type]
        equipment_id=data["recurring_equipment"],  # type: ignore[arg-type]
        executor_id=data["executor_id"],  # type: ignore[arg-type]
        priority=Priority.HIGH,
        deadline=datetime.now(UTC) + timedelta(days=2),
    )
    key = "legacy-idempotency-key"
    created = await create_order(database, data["master"], body, key)  # type: ignore[arg-type]
    legacy_payload = body.model_dump(mode="json", exclude={"prevention_source"})
    async with database.sessions() as session:
        record = await session.get(
            IdempotencyRecord,
            (data["master"].employee_id, key),  # type: ignore[union-attr]
        )
        assert record is not None
        assert record.request_hash == _request_hash("create_order", legacy_payload)
    assert (
        await create_order(database, data["master"], body, key)  # type: ignore[arg-type]
    ) == created
