"""Login/me/logout endpoints; tokens never appear in list responses or logs."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator
from sqlalchemy import update

from naryadai.auth.dependencies import DatabaseDep, PrincipalDep
from naryadai.auth.service import login
from naryadai.infrastructure.models import AuthSession

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    login: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{2,63}$")]
    secret: SecretStr = Field(min_length=6, max_length=128)

    @field_validator("login", mode="before")
    @classmethod
    def trim_login(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_at: datetime


class UserResponse(BaseModel):
    id: UUID
    login: str
    display_name: str
    role: str
    area_ids: tuple[UUID, ...]


@router.post("/login", response_model=TokenResponse)
async def sign_in(body: LoginRequest, request: Request, database: DatabaseDep) -> TokenResponse:
    # Never trust X-Forwarded-For from an arbitrary client.
    peer = request.client.host if request.client else "unknown"
    async with database.sessions.begin() as session:
        result = await login(
            session,
            username=body.login,
            secret=body.secret.get_secret_value(),
            peer=peer,
            settings=request.app.state.settings,
            limiter=request.app.state.auth_limiter,
        )
    if result.status_code == 429:
        raise HTTPException(
            status_code=429,
            detail="too_many_attempts",
            headers={"Retry-After": str(request.app.state.settings.login_window_seconds)},
        )
    if result.token is None or result.expires_at is None:
        raise HTTPException(status_code=401, detail="invalid_credentials")
    return TokenResponse(access_token=result.token, expires_at=result.expires_at)


@router.get("/me", response_model=UserResponse)
async def me(principal: PrincipalDep) -> UserResponse:
    return UserResponse(
        id=principal.employee_id,
        login=principal.login,
        display_name=principal.display_name,
        role=principal.role,
        area_ids=principal.area_ids,
    )


@router.post("/logout", status_code=204)
async def sign_out(principal: PrincipalDep, database: DatabaseDep) -> Response:
    async with database.sessions.begin() as session:
        await session.execute(
            update(AuthSession)
            .where(AuthSession.id == principal.session_id)
            .values(revoked_at=datetime.now(UTC))
        )
    return Response(status_code=204)
