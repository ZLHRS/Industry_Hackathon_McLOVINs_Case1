"""Separate process liveness from PostgreSQL schema readiness."""

from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from naryadai.infrastructure.database import SCHEMA_REVISION, Database

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: Literal["naryadai"] = "naryadai"


@router.get("/health/live", response_model=HealthResponse)
async def liveness() -> HealthResponse:
    return HealthResponse()


@router.get("/health/ready", responses={503: {"description": "Database or schema unavailable"}})
async def readiness(request: Request) -> JSONResponse:
    database = getattr(request.app.state, "database", None)
    ready = False
    if isinstance(database, Database):
        try:
            async with database.sessions() as session:
                revisions = (
                    await session.scalars(text("SELECT version_num FROM alembic_version"))
                ).all()
                ready = revisions == [SCHEMA_REVISION]
        except SQLAlchemyError:
            ready = False
    return JSONResponse(
        status_code=200 if ready else 503,
        content={"status": "ready" if ready else "not_ready"},
    )
