"""HTTP transport for executor fault reports."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query

from naryadai.api.orders import IdempotencyKey
from naryadai.application.fault_reports import (
    CreateFaultReport,
    DismissFaultReport,
    FaultReportPage,
    FaultReportView,
    MasterOptions,
    create_report,
    dismiss_report,
    list_reports,
    report_detail,
)
from naryadai.auth.dependencies import DatabaseDep, PrincipalDep

router = APIRouter(prefix="/fault-reports", tags=["fault-reports"])


@router.get("/masters", response_model=MasterOptions)
async def masters(
    equipment_id: UUID, principal: PrincipalDep, database: DatabaseDep
) -> MasterOptions:
    from naryadai.application.fault_reports import masters_for_equipment

    return await masters_for_equipment(database, principal, equipment_id)


@router.post("", response_model=FaultReportView, status_code=201)
async def create(
    body: CreateFaultReport,
    principal: PrincipalDep,
    database: DatabaseDep,
    idempotency_key: IdempotencyKey,
) -> FaultReportView:
    report = await create_report(database, principal, body, idempotency_key)
    return await report_detail(database, principal, report.id)


@router.get("", response_model=FaultReportPage)
async def listed(
    principal: PrincipalDep,
    database: DatabaseDep,
    status: Literal["open", "all"] = "open",
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
) -> FaultReportPage:
    return await list_reports(database, principal, status, offset, limit)


@router.get("/{report_id}", response_model=FaultReportView)
async def detail(
    report_id: UUID, principal: PrincipalDep, database: DatabaseDep
) -> FaultReportView:
    return await report_detail(database, principal, report_id)


@router.post("/{report_id}/dismiss", response_model=FaultReportView)
async def dismiss(
    report_id: UUID,
    body: DismissFaultReport,
    principal: PrincipalDep,
    database: DatabaseDep,
) -> FaultReportView:
    return await dismiss_report(database, principal, report_id, body)
