"""Authorized recording of factual downtime and a master's refusal decision."""

from uuid import UUID

from fastapi import APIRouter

from naryadai.api.orders import IdempotencyKey, MutationView
from naryadai.application.report_evidence import (
    DowntimeRecord,
    RefusalAssessment,
    save_report_evidence,
)
from naryadai.auth.dependencies import DatabaseDep, PrincipalDep

router = APIRouter(tags=["report-evidence"])


@router.post("/work-orders/{order_id}/downtime", response_model=MutationView)
async def record_downtime(
    order_id: UUID,
    body: DowntimeRecord,
    principal: PrincipalDep,
    database: DatabaseDep,
    idempotency_key: IdempotencyKey,
) -> MutationView:
    return MutationView.model_validate(
        await save_report_evidence(database, principal, order_id, body, idempotency_key)
    )


@router.post(
    "/work-orders/{order_id}/refusals/{rejection_event_id}/assessment", response_model=MutationView
)
async def assess_refusal(
    order_id: UUID,
    rejection_event_id: UUID,
    body: RefusalAssessment,
    principal: PrincipalDep,
    database: DatabaseDep,
    idempotency_key: IdempotencyKey,
) -> MutationView:
    return MutationView.model_validate(
        await save_report_evidence(
            database,
            principal,
            order_id,
            body,
            idempotency_key,
            rejection_event_id=rejection_event_id,
        )
    )
