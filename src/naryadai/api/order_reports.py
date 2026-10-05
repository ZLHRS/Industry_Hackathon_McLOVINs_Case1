"""Download private full work-order Excel reports."""

from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import Response

from naryadai.auth.dependencies import DatabaseDep, PrincipalDep
from naryadai.reporting.order_report import export_order

router = APIRouter(tags=["reports"])
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.get(
    "/work-orders/{order_id}/report.xlsx",
    response_class=Response,
    responses={200: {"content": {XLSX: {"schema": {"type": "string", "format": "binary"}}}}},
)
async def order_excel(
    order_id: UUID,
    principal: PrincipalDep,
    database: DatabaseDep,
    request: Request,
) -> Response:
    content = await export_order(
        database,
        principal,
        order_id,
        request.app.state.photo_store,
        request.app.state.report_limiter,
    )
    return Response(
        content,
        media_type=XLSX,
        headers={
            "Content-Disposition": 'attachment; filename="naryadai-order.xlsx"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
