"""Application factory. Run with: uvicorn naryadai.app:create_app --factory."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from importlib.metadata import version

from anyio import CapacityLimiter
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from naryadai.api.auth import router as auth_router
from naryadai.api.catalog import router as catalog_router
from naryadai.api.health import router as health_router
from naryadai.config import Environment, Settings
from naryadai.infrastructure.database import Database
from naryadai.observability import RequestContextMiddleware, configure_access_logger


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else Settings()
    production = settings.environment == Environment.PRODUCTION

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        database = (
            Database(settings.database_url.get_secret_value()) if settings.database_url else None
        )
        application.state.database = database
        application.state.auth_limiter = CapacityLimiter(4)
        try:
            yield
        finally:
            if database is not None:
                await database.dispose()

    app = FastAPI(
        lifespan=lifespan,
        title="NaryadAI",
        summary="Industrial maintenance work orders and decision support",
        version=version("naryadai"),
        debug=False,
        docs_url=None if production else "/docs",
        redoc_url=None,
        openapi_url=None if production else "/openapi.json",
    )
    app.state.settings = settings
    app.include_router(health_router, prefix="/api/v1")
    app.include_router(auth_router, prefix="/api/v1")
    app.include_router(catalog_router, prefix="/api/v1")

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, error: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "detail": [
                    {"loc": list(item["loc"]), "type": item["type"], "msg": item["msg"]}
                    for item in error.errors()
                ]
            },
        )

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, _exception: Exception) -> JSONResponse:
        request_id = request.state.request_id
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error", "request_id": request_id},
            headers={
                "X-Request-ID": request_id,
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "no-store",
            },
        )

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Content-Type", "Authorization", "Idempotency-Key"],
            expose_headers=["X-Request-ID"],
        )
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=list(settings.allowed_hosts),
        www_redirect=False,
    )
    app.add_middleware(
        RequestContextMiddleware,
        logger=configure_access_logger(settings.log_level),
    )
    return app
