"""Durable executor fault reports and target-master triage."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import exists, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from naryadai.application.common import OperationError
from naryadai.auth.dependencies import Principal
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import (
    Area,
    Employee,
    EmployeeArea,
    EmployeeRole,
    Equipment,
    FaultReport,
    WorkOrder,
)


class CreateFaultReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)
    equipment_id: UUID
    master_id: UUID
    description: str = Field(min_length=3, max_length=10_000)


class DismissFaultReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)
    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=3, max_length=1_000)


class MasterOption(BaseModel):
    id: UUID
    display_name: str


class MasterOptions(BaseModel):
    items: list[MasterOption]


class FaultReportView(BaseModel):
    id: UUID
    equipment_id: UUID
    equipment_inventory_number: str
    equipment_name: str
    area_id: UUID
    area_name: str
    reporter_id: UUID
    reporter_name: str
    master_id: UUID
    master_name: str
    description: str
    status: str
    version: int
    created_at: datetime
    resolved_at: datetime | None
    dismissal_reason: str | None
    work_order_number: str | None


class FaultReportPage(BaseModel):
    items: list[FaultReportView]
    total: int
    offset: int
    limit: int


def _digest(body: CreateFaultReport) -> str:
    return hashlib.sha256(
        json.dumps(body.model_dump(mode="json"), sort_keys=True).encode()
    ).hexdigest()


async def _equipment_for_report(
    session: AsyncSession, principal: Principal, equipment_id: UUID
) -> Equipment:
    if (
        await session.scalar(
            select(Employee.id).where(
                Employee.id == principal.employee_id,
                Employee.role == EmployeeRole.EXECUTOR,
                Employee.is_active.is_(True),
            )
        )
        is None
    ):
        raise OperationError(403, "reporter_not_authorized")
    equipment = await session.scalar(
        select(Equipment).where(Equipment.id == equipment_id).with_for_update()
    )
    area = None if equipment is None else await session.get(Area, equipment.area_id)
    if (
        equipment is None
        or not equipment.is_active
        or area is None
        or not area.is_active
        or equipment.area_id not in principal.area_ids
    ):
        raise OperationError(422, "equipment_not_found")
    if (
        await session.scalar(
            select(EmployeeArea.employee_id).where(
                EmployeeArea.employee_id == principal.employee_id,
                EmployeeArea.area_id == equipment.area_id,
            )
        )
        is None
    ):
        raise OperationError(403, "reporter_not_authorized")
    return equipment


async def _master_for_report(session: AsyncSession, master_id: UUID, area_id: UUID) -> None:
    master = await session.scalar(
        select(Employee).where(Employee.id == master_id).with_for_update()
    )
    if master is None or master.role is not EmployeeRole.MASTER or not master.is_active:
        raise OperationError(422, "master_not_authorized")
    if (
        await session.scalar(
            select(EmployeeArea.employee_id).where(
                EmployeeArea.employee_id == master_id, EmployeeArea.area_id == area_id
            )
        )
        is None
    ):
        raise OperationError(422, "master_not_authorized")


async def create_report(
    database: Database, principal: Principal, body: CreateFaultReport, key: str
) -> FaultReport:
    if principal.role != "executor":
        raise OperationError(403, "role_not_permitted")
    digest = _digest(body)
    async with database.sessions.begin() as session:
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:key))"),
            {"key": f"report:{principal.employee_id}:{key}"},
        )
        equipment = await _equipment_for_report(session, principal, body.equipment_id)
        await _master_for_report(session, body.master_id, equipment.area_id)
        existing = await session.scalar(
            select(FaultReport).where(
                FaultReport.reporter_id == principal.employee_id, FaultReport.idempotency_key == key
            )
        )
        if existing is not None:
            if existing.request_hash != digest:
                raise OperationError(409, "idempotency_key_conflict")
            return existing
        report = FaultReport(
            equipment_id=equipment.id,
            area_id=equipment.area_id,
            reporter_id=principal.employee_id,
            master_id=body.master_id,
            description=body.description,
            idempotency_key=key,
            request_hash=digest,
        )
        session.add(report)
        await session.flush()
        from naryadai.application.notification_engine import new_fault_report_notification

        await new_fault_report_notification(
            session,
            employee_id=report.master_id,
            report=report,
            kind="fault_report_created",
            title="Сообщение о неисправности",  # noqa: RUF001
            body=f"Новое сообщение по оборудованию {equipment.inventory_number}: {equipment.name}",
            action_required=True,
            now=report.created_at,
        )
        return report


async def masters_for_equipment(
    database: Database, principal: Principal, equipment_id: UUID
) -> MasterOptions:
    if principal.role != "executor":
        raise OperationError(403, "role_not_permitted")
    async with database.sessions() as session:
        equipment = await _equipment_for_report(session, principal, equipment_id)
        rows = await session.execute(
            select(Employee.id, Employee.display_name)
            .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
            .where(
                Employee.role == EmployeeRole.MASTER,
                Employee.is_active.is_(True),
                EmployeeArea.area_id == equipment.area_id,
            )
            .order_by(Employee.display_name, Employee.id)
        )
        return MasterOptions(
            items=[MasterOption(id=row.id, display_name=row.display_name) for row in rows]
        )


def _scope(principal: Principal) -> ColumnElement[bool]:
    live = exists(
        select(Employee.id)
        .join(EmployeeArea, EmployeeArea.employee_id == Employee.id)
        .where(
            Employee.id == principal.employee_id,
            Employee.is_active.is_(True),
            Employee.role == principal.role,
            EmployeeArea.area_id == FaultReport.area_id,
        )
        .correlate(FaultReport)
    )
    if principal.role == "executor":
        return (FaultReport.reporter_id == principal.employee_id) & live
    if principal.role == "master":
        return (
            (FaultReport.master_id == principal.employee_id)
            & FaultReport.area_id.in_(principal.area_ids)
            & live
        )
    raise OperationError(403, "role_not_permitted")


async def _view(session: AsyncSession, report: FaultReport) -> FaultReportView:
    equipment = await session.get(Equipment, report.equipment_id)
    reporter = await session.get(Employee, report.reporter_id)
    master = await session.get(Employee, report.master_id)
    order = await session.scalar(select(WorkOrder).where(WorkOrder.fault_report_id == report.id))
    from naryadai.infrastructure.models import Area

    area = await session.get(Area, report.area_id)
    assert equipment and reporter and master and area
    return FaultReportView(
        id=report.id,
        equipment_id=equipment.id,
        equipment_inventory_number=equipment.inventory_number,
        equipment_name=equipment.name,
        area_id=area.id,
        area_name=area.name,
        reporter_id=reporter.id,
        reporter_name=reporter.display_name,
        master_id=master.id,
        master_name=master.display_name,
        description=report.description,
        status=report.status,
        version=report.version,
        created_at=report.created_at,
        resolved_at=report.resolved_at,
        dismissal_reason=report.dismissal_reason,
        work_order_number=None if order is None else order.number,
    )


async def list_reports(
    database: Database, principal: Principal, status: str, offset: int, limit: int
) -> FaultReportPage:
    if status not in {"open", "all"}:
        raise OperationError(422, "invalid_status")
    async with database.sessions() as session:
        query = select(FaultReport).where(_scope(principal))
        if status == "open":
            query = query.where(FaultReport.status == "open")
        count_query = select(func.count()).select_from(FaultReport).where(_scope(principal))
        if status == "open":
            count_query = count_query.where(FaultReport.status == "open")
        total = int(await session.scalar(count_query) or 0)
        rows = list(
            (
                await session.scalars(
                    query.order_by(FaultReport.created_at.desc()).offset(offset).limit(limit)
                )
            ).all()
        )
        return FaultReportPage(
            items=[await _view(session, row) for row in rows],
            total=total,
            offset=offset,
            limit=limit,
        )


async def report_detail(
    database: Database, principal: Principal, report_id: UUID
) -> FaultReportView:
    async with database.sessions() as session:
        report = await session.scalar(
            select(FaultReport).where(FaultReport.id == report_id, _scope(principal))
        )
        if report is None:
            raise OperationError(404, "fault_report_not_found")
        return await _view(session, report)


async def dismiss_report(
    database: Database, principal: Principal, report_id: UUID, body: DismissFaultReport
) -> FaultReportView:
    if principal.role != "master":
        raise OperationError(403, "role_not_permitted")
    async with database.sessions.begin() as session:
        report = await session.scalar(
            select(FaultReport)
            .where(FaultReport.id == report_id, _scope(principal))
            .with_for_update()
        )
        if report is None:
            raise OperationError(404, "fault_report_not_found")
        if (
            report.status == "dismissed"
            and report.version == body.expected_version + 1
            and report.dismissal_reason == body.reason
        ):
            return await _view(session, report)
        if report.version != body.expected_version:
            raise OperationError(409, "version_conflict")
        if report.status != "open":
            raise OperationError(409, "fault_report_not_open")
        now = datetime.now(UTC)
        report.status, report.dismissal_reason, report.resolved_at, report.version = (
            "dismissed",
            body.reason,
            now,
            report.version + 1,
        )
        await session.flush()
        from naryadai.application.notification_engine import new_fault_report_notification

        await new_fault_report_notification(
            session,
            employee_id=report.reporter_id,
            report=report,
            kind="fault_report_dismissed",
            title="Сообщение о неисправности отклонено",  # noqa: RUF001
            body=f"Причина: {report.dismissal_reason}",
            action_required=False,
            now=now,
        )
        return await _view(session, report)
