"""Export and on-demand narrative use the same authorized analytics snapshot."""

from anyio import to_thread
from fastapi import APIRouter, Request
from fastapi.responses import Response

from naryadai.ai import OpenAIReviewConfig
from naryadai.analytics.service import build_report
from naryadai.analytics.summary import AnalyticsSummary, summarize_analytics
from naryadai.api.analytics import AnalyticsQueryDep
from naryadai.api.order_reports import XLSX
from naryadai.auth.dependencies import DatabaseDep, PrincipalDep
from naryadai.config import Settings
from naryadai.reporting.analytics_report import export_analytics
from naryadai.reporting.limits import SummaryLimits

router = APIRouter(tags=["reports"])


@router.get(
    "/analytics/export",
    response_class=Response,
    responses={200: {"content": {XLSX: {"schema": {"type": "string", "format": "binary"}}}}},
)
async def analytics_excel(
    principal: PrincipalDep,
    database: DatabaseDep,
    query: AnalyticsQueryDep,
    request: Request,
) -> Response:
    report = await build_report(database, principal, query)
    content = await to_thread.run_sync(
        export_analytics, report, limiter=request.app.state.report_limiter
    )
    return Response(
        content,
        media_type=XLSX,
        headers={
            "Content-Disposition": 'attachment; filename="naryadai-analytics.xlsx"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/analytics/summary", response_model=AnalyticsSummary)
async def analytics_summary(
    principal: PrincipalDep,
    database: DatabaseDep,
    query: AnalyticsQueryDep,
    request: Request,
) -> AnalyticsSummary:
    report = await build_report(database, principal, query)
    limits: SummaryLimits = request.app.state.summary_limits
    limits.reserve(principal.employee_id)
    try:
        settings: Settings = request.app.state.settings
        config = OpenAIReviewConfig(
            api_key=settings.ai_api_key,
            model=settings.ai_model,
            reasoning_effort=settings.ai_reasoning_effort,
            max_output_tokens=settings.ai_max_output_tokens,
            request_timeout_seconds=settings.ai_timeout_seconds,
            total_timeout_seconds=settings.ai_total_timeout_seconds,
        )
        return await summarize_analytics(report, config)
    finally:
        limits.release()
