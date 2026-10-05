# ruff: noqa: B008
"""Analytics HTTP transport and reusable query dependency."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query

from naryadai.analytics.contracts import AnalyticsOptions, AnalyticsQuery, AnalyticsReport
from naryadai.analytics.service import analytics_options, build_report
from naryadai.auth.dependencies import DatabaseDep, PrincipalDep

router = APIRouter(prefix="/analytics", tags=["analytics"])


def _ids(values: list[str]) -> tuple[UUID, ...]:
    parts = [part for raw in values for part in raw.split(",") if part]
    return tuple(UUID(part) for part in parts)


async def analytics_query(
    period: str = Query(default="day"),
    shift: str | None = Query(default=None),
    date: str | None = Query(default=None),
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    timezone: str = Query(default="Asia/Qostanay", min_length=1, max_length=64),
    area_id: list[str] = Query(default_factory=list),
    equipment_id: list[str] = Query(default_factory=list),
    executor_id: list[str] = Query(default_factory=list),
    brigade_id: list[str] = Query(default_factory=list),
) -> AnalyticsQuery:
    try:
        local_date = (
            datetime.now(ZoneInfo(timezone)).date() if date is None and period != "custom" else date
        )
        return AnalyticsQuery.model_validate(
            {
                "period": period,
                "shift": shift,
                "date": local_date,
                "from": from_,
                "to": to,
                "timezone": timezone,
                "area_ids": _ids(area_id),
                "equipment_ids": _ids(equipment_id),
                "executor_ids": _ids(executor_id),
                "brigade_ids": _ids(brigade_id),
            }
        )
    except (ValueError, TypeError, ZoneInfoNotFoundError, OverflowError):
        raise HTTPException(status_code=422, detail="invalid_analytics_query") from None


AnalyticsQueryDep = Annotated[AnalyticsQuery, Depends(analytics_query)]


@router.get("/report", response_model=AnalyticsReport)
async def report(
    principal: PrincipalDep, database: DatabaseDep, query: AnalyticsQueryDep
) -> AnalyticsReport:
    return await build_report(database, principal, query)


@router.get("/options", response_model=AnalyticsOptions)
async def options(principal: PrincipalDep, database: DatabaseDep) -> AnalyticsOptions:
    return await analytics_options(database, principal)
