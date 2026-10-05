"""Async SQLAlchemy engine and session factory for PostgreSQL."""

from __future__ import annotations

from typing import Any, Final

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

_POSTGRESQL_PREFIX: Final = "postgresql+psycopg://"
SCHEMA_REVISION: Final = "0001_initial_schema"


class Database:
    """Own an async PostgreSQL engine and its unit-of-work session factory.

    The constructor only accepts the psycopg async PostgreSQL dialect. It keeps
    URL query parameters intact so isolated test schemas can use libpq options
    such as ``search_path``. Connection-level server timeouts are set after
    connecting rather than replacing URL options.
    """

    def __init__(self, url: str, *, use_null_pool: bool = False) -> None:
        if not url.startswith(_POSTGRESQL_PREFIX):
            raise ValueError("database URL must use postgresql+psycopg://")

        engine_options: dict[str, object] = {
            "connect_args": {"connect_timeout": 5},
            "hide_parameters": True,
            "pool_pre_ping": True,
        }
        if use_null_pool:
            engine_options["poolclass"] = NullPool
        else:
            engine_options.update(
                {
                    "pool_size": 5,
                    "max_overflow": 10,
                    "pool_timeout": 10,
                    "pool_recycle": 1_800,
                }
            )

        self.engine: AsyncEngine = create_async_engine(url, **engine_options)
        self.sessions: async_sessionmaker[AsyncSession] = async_sessionmaker(
            self.engine,
            autoflush=False,
            expire_on_commit=False,
        )
        _install_server_timeouts(self.engine)

    async def dispose(self) -> None:
        """Close pooled connections during application shutdown or test cleanup."""

        await self.engine.dispose()


def _install_server_timeouts(engine: AsyncEngine) -> None:
    """Apply bounded PostgreSQL command timeouts without changing URL options."""

    @event.listens_for(engine.sync_engine, "connect")
    def set_timeouts(dbapi_connection: Any, _connection_record: Any) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("SET statement_timeout = '30000'")
            cursor.execute("SET lock_timeout = '5000'")
            cursor.execute("SET idle_in_transaction_session_timeout = '60000'")
        finally:
            cursor.close()
        dbapi_connection.commit()
