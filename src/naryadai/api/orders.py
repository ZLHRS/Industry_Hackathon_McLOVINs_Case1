"""HTTP transport for order commands and scoped operational read models."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Query
from pydantic import BaseModel

from naryadai.application.contracts import CreateOrder, OrderAction
from naryadai.application.orders import create_order, execute_action
from naryadai.application.queries import (
    EventPage,
    MasterOption,
    OrderDetail,
    OrderPage,
    WorkloadView,
    equipment_history,
    list_orders,
    master_options,
    order_detail,
    order_events,
    workload,
)
from naryadai.auth.dependencies import DatabaseDep, PrincipalDep
from naryadai.domain.lifecycle import WorkOrderStatus
from naryadai.infrastructure.models import Priority, WorkType

router = APIRouter(tags=["work-orders"])
IdempotencyKey = Annotated[
    str,
    Header(
        alias="Idempotency-Key",
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9._:-]+$",
    ),
]


class MutationView(BaseModel):
    order_id: UUID
    version: int
    status: WorkOrderStatus


@router.post("/work-orders", response_model=MutationView, status_code=201)
async def issue_order(
    body: CreateOrder,
    principal: PrincipalDep,
    database: DatabaseDep,
    idempotency_key: IdempotencyKey,
) -> MutationView:
    return MutationView.model_validate(
        await create_order(database, principal, body, idempotency_key)
    )


@router.post("/work-orders/{order_id}/actions", response_model=MutationView)
async def change_order(
    order_id: UUID,
    body: OrderAction,
    principal: PrincipalDep,
    database: DatabaseDep,
    idempotency_key: IdempotencyKey,
) -> MutationView:
    return MutationView.model_validate(
        await execute_action(database, principal, order_id, body, idempotency_key)
    )


@router.get("/work-orders", response_model=OrderPage)
async def orders(
    principal: PrincipalDep,
    database: DatabaseDep,
    status: Annotated[list[WorkOrderStatus] | None, Query()] = None,
    area_id: UUID | None = None,
    equipment_id: UUID | None = None,
    executor_id: UUID | None = None,
    master_id: UUID | None = None,
    priority: Priority | None = None,
    work_type: WorkType | None = None,
    overdue: bool | None = None,
    q: str | None = Query(default=None, max_length=120),
    attention: bool = False,
    offset: int = Query(default=0, ge=0, le=100_000),
    limit: int = Query(default=50, ge=1, le=200),
) -> OrderPage:
    return await list_orders(
        database,
        principal,
        statuses=status,
        area_id=area_id,
        equipment_id=equipment_id,
        executor_id=executor_id,
        master_id=master_id,
        priority=priority,
        work_type=work_type,
        overdue=overdue,
        q=q,
        attention=attention,
        offset=offset,
        limit=limit,
    )


@router.get("/work-orders/masters", response_model=list[MasterOption])
async def order_masters(principal: PrincipalDep, database: DatabaseDep) -> list[MasterOption]:
    return await master_options(database, principal)


@router.get("/work-orders/{order_id}", response_model=OrderDetail)
async def detail(order_id: UUID, principal: PrincipalDep, database: DatabaseDep) -> OrderDetail:
    return await order_detail(database, principal, order_id)


@router.get("/work-orders/{order_id}/events", response_model=EventPage)
async def history(
    order_id: UUID,
    principal: PrincipalDep,
    database: DatabaseDep,
    after_sequence: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=200),
) -> EventPage:
    return await order_events(
        database,
        principal,
        order_id,
        after_sequence=after_sequence,
        limit=limit,
    )


@router.get("/equipment/{equipment_id}/history", response_model=OrderPage)
async def machine_history(
    equipment_id: UUID,
    principal: PrincipalDep,
    database: DatabaseDep,
    offset: int = Query(default=0, ge=0, le=100_000),
    limit: int = Query(default=50, ge=1, le=200),
) -> OrderPage:
    return await equipment_history(database, principal, equipment_id, offset=offset, limit=limit)


@router.get("/workload", response_model=list[WorkloadView])
async def staff_workload(
    principal: PrincipalDep,
    database: DatabaseDep,
    area_id: UUID | None = None,
    offset: int = Query(default=0, ge=0, le=100_000),
    limit: int = Query(default=100, ge=1, le=200),
) -> list[WorkloadView]:
    return await workload(database, principal, area_id=area_id, offset=offset, limit=limit)
