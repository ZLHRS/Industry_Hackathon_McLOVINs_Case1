"""Read-only validation of analytics signals used to issue preventive orders."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from naryadai.analytics.contracts import AnalyticsReport, AnomalyView
from naryadai.analytics.service import build_report
from naryadai.application.common import OperationError, ensure_role
from naryadai.application.contracts import PreventionSource
from naryadai.auth.dependencies import Principal
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import Area, Equipment, WorkOrder


class EvidenceOrder(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    number: str


class PreventiveDraft(BaseModel):
    model_config = ConfigDict(frozen=True)

    area_id: UUID
    equipment_id: UUID
    description: str
    fault_code_id: UUID | None = None
    title: str
    source: PreventionSource
    evidence_orders: list[EvidenceOrder] = Field(default_factory=list)


@dataclass(frozen=True)
class ValidatedPrevention:
    draft: PreventiveDraft
    recommendation: str
    report: AnalyticsReport
    formula: str


def _anomaly_order_ids(anomaly: AnomalyView) -> tuple[UUID, ...] | None:
    values = anomaly.evidence.get("order_ids")
    if not isinstance(values, list):
        return None
    try:
        return tuple(sorted((UUID(str(value)) for value in values), key=str))
    except (TypeError, ValueError):
        return None


def _matching_anomaly(report: AnalyticsReport, source: PreventionSource) -> AnomalyView | None:
    for anomaly in report.anomalies:
        if anomaly.family != source.family:
            continue
        if anomaly.evidence.get("equipment_id") != str(source.equipment_id):
            continue
        if _anomaly_order_ids(anomaly) == source.order_ids:
            return anomaly
    return None


async def _visible_active_equipment(
    database: Database, principal: Principal, equipment_id: UUID
) -> tuple[Equipment, Area]:
    async with database.sessions.begin() as session:
        row = await session.execute(
            select(Equipment, Area)
            .join(Area, Area.id == Equipment.area_id)
            .where(Equipment.id == equipment_id, Equipment.area_id.in_(principal.area_ids))
        )
        pair = row.one_or_none()
    if pair is None:
        # Do not distinguish a foreign asset from a nonexistent asset.
        raise OperationError(404, "prevention_equipment_not_found")
    equipment, area = pair
    if not area.is_active:
        raise OperationError(409, "area_inactive")
    if not equipment.is_active:
        raise OperationError(409, "equipment_inactive")
    return equipment, area


def _recommendation(family: str) -> str:
    if family == "recurring_fault":
        return (
            "Проверьте первопричину повторной неисправности, устраните её и подтвердите "
            "результат контрольной проверкой."
        )
    return (
        "Проверьте объём и качество выполненного ППР, устраните выявленные отклонения и "
        "зафиксируйте контрольный результат."
    )


async def validate_prevention_source(
    database: Database, principal: Principal, source: PreventionSource
) -> ValidatedPrevention:
    """Rebuild the caller's report and accept only its exact current anomaly."""

    ensure_role(principal, "master")
    equipment, area = await _visible_active_equipment(database, principal, source.equipment_id)
    report = await build_report(database, principal, source.query)
    anomaly = _matching_anomaly(report, source)
    if anomaly is None:
        raise OperationError(409, "prevention_source_stale")

    async with database.sessions.begin() as session:
        rows = list(
            await session.scalars(
                select(WorkOrder)
                .where(
                    WorkOrder.id.in_(source.order_ids),
                    WorkOrder.equipment_id == equipment.id,
                    WorkOrder.area_id == area.id,
                )
                .order_by(WorkOrder.number)
            )
        )
    found = {row.id: row for row in rows}
    if set(found) != set(source.order_ids):
        raise OperationError(409, "prevention_source_stale")

    fault_code_id: UUID | None = None
    if source.family == "recurring_fault":
        fault_ids = {row.fault_code_id for row in rows}
        if len(fault_ids) != 1 or None in fault_ids:
            raise OperationError(409, "prevention_source_stale")
        fault_code_id = rows[0].fault_code_id
        if fault_code_id is None:
            raise OperationError(409, "prevention_source_stale")

    recommendation = _recommendation(source.family)
    draft = PreventiveDraft(
        area_id=area.id,
        equipment_id=equipment.id,
        description=recommendation,
        fault_code_id=fault_code_id,
        title=anomaly.title,
        source=source,
        evidence_orders=[EvidenceOrder(id=row.id, number=row.number) for row in rows],
    )
    return ValidatedPrevention(
        draft=draft, recommendation=recommendation, report=report, formula=anomaly.formula
    )


async def prepare_preventive_draft(
    database: Database, principal: Principal, source: PreventionSource
) -> PreventiveDraft:
    return (await validate_prevention_source(database, principal, source)).draft


def prevention_event_details(validated: ValidatedPrevention) -> dict[str, object]:
    """Server-derived provenance for the append-only work-order issue event."""

    draft = validated.draft
    return {
        "family": draft.source.family,
        "query": draft.source.query.model_dump(mode="json", by_alias=True),
        "equipment_id": str(draft.equipment_id),
        "order_ids": [str(order_id) for order_id in draft.source.order_ids],
        "title": draft.title,
        "recommendation": validated.recommendation,
        "formula": validated.formula,
        "evidence_orders": [item.model_dump(mode="json") for item in draft.evidence_orders],
        "period": validated.report.period.model_dump(mode="json", by_alias=True),
    }
