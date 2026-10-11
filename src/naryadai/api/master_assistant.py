"""HTTP transport for citation-grounded master-assistant answers."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from naryadai.ai import OpenAIReviewConfig
from naryadai.application.common import OperationError, ensure_role
from naryadai.application.master_assistant import (
    AssistantQuestion,
    MasterAssistantAnswer,
    master_assistant_answer,
)
from naryadai.auth.dependencies import DatabaseDep, PrincipalDep
from naryadai.config import Settings

router = APIRouter(prefix="/master-assistant", tags=["master-assistant"])


@router.post("/answer", response_model=MasterAssistantAnswer)
async def answer(
    body: AssistantQuestion,
    principal: PrincipalDep,
    database: DatabaseDep,
    request: Request,
) -> MasterAssistantAnswer:
    ensure_role(principal, "master")
    settings: Settings = request.app.state.settings
    limits = request.app.state.assistant_limits
    limits.reserve(principal.employee_id)
    try:
        config = OpenAIReviewConfig(
            api_key=settings.ai_api_key,
            model=settings.ai_model,
            reasoning_effort="low",
            max_output_tokens=2048,
            request_timeout_seconds=min(settings.ai_timeout_seconds, 10),
            total_timeout_seconds=min(settings.ai_total_timeout_seconds, 12),
        )
        return await master_assistant_answer(database, principal, body, config)
    except OperationError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from None
    finally:
        limits.release(principal.employee_id)
