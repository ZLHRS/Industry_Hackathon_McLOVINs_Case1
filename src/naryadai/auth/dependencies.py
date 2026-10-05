"""Authentication and area scope; no implicit privilege inheritance."""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select

from naryadai.auth.security import fingerprint
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.models import AuthSession, Employee, EmployeeArea

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    employee_id: UUID
    session_id: UUID
    login: str
    display_name: str
    role: str
    area_ids: tuple[UUID, ...]


def get_database(request: Request) -> Database:
    database = getattr(request.app.state, "database", None)
    if not isinstance(database, Database):
        raise HTTPException(status_code=503, detail="database_unavailable")
    return database


DatabaseDep = Annotated[Database, Depends(get_database)]


async def authenticate_token(database: Database, token: str) -> Principal | None:
    """Resolve a live session for HTTP and long-lived connections using the same policy."""
    if len(token) != 43:
        return None
    async with database.sessions() as session:
        row = (
            await session.execute(
                select(Employee, AuthSession)
                .join(AuthSession, AuthSession.employee_id == Employee.id)
                .where(
                    AuthSession.token_hash == fingerprint(token),
                    AuthSession.revoked_at.is_(None),
                    AuthSession.expires_at > datetime.now(UTC),
                    Employee.is_active.is_(True),
                )
            )
        ).one_or_none()
        if row is None:
            return None
        employee, auth_session = row
        areas = tuple(
            (
                await session.scalars(
                    select(EmployeeArea.area_id).where(EmployeeArea.employee_id == employee.id)
                )
            ).all()
        )
        return Principal(
            employee.id,
            auth_session.id,
            employee.login,
            employee.display_name,
            employee.role,
            areas,
        )


async def current_principal(
    database: DatabaseDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> Principal:
    principal = None
    if credentials is not None and credentials.scheme.lower() == "bearer":
        principal = await authenticate_token(database, credentials.credentials)
    if principal is None:
        raise HTTPException(
            status_code=401,
            detail="authentication_required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return principal


PrincipalDep = Annotated[Principal, Depends(current_principal)]


def require_admin(principal: Principal) -> None:
    if principal.role != "admin":
        raise HTTPException(status_code=403, detail="admin_required")


def require_area(principal: Principal, area_id: UUID) -> None:
    if principal.role != "admin" and area_id not in principal.area_ids:
        raise HTTPException(status_code=404, detail="not_found")
