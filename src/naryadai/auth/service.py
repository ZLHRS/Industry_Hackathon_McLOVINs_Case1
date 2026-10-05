"""Database-backed login limits and revocable opaque sessions."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from anyio import CapacityLimiter, to_thread
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from naryadai.auth.security import fingerprint, new_token, verify_secret
from naryadai.config import Settings
from naryadai.infrastructure.models import AuthSession, Employee, LoginThrottle


@dataclass(frozen=True)
class LoginResult:
    token: str | None = None
    expires_at: datetime | None = None
    status_code: int = 401


async def _consume(
    session: AsyncSession, key: str, limit: int, now: datetime, window_seconds: int
) -> bool:
    await session.execute(
        insert(LoginThrottle)
        .values(key=key, window_started_at=now, attempts=0)
        .on_conflict_do_nothing(index_elements=["key"])
    )
    row = await session.scalar(
        select(LoginThrottle).where(LoginThrottle.key == key).with_for_update()
    )
    assert row is not None
    if now >= row.window_started_at + timedelta(seconds=window_seconds):
        row.window_started_at = now
        row.attempts = 0
    if row.attempts >= limit:
        return False
    row.attempts += 1
    return True


async def login(
    session: AsyncSession,
    *,
    username: str,
    secret: str,
    peer: str,
    settings: Settings,
    limiter: CapacityLimiter,
) -> LoginResult:
    """Caller commits this transaction even on denied login, preserving attempt counters."""
    now = datetime.now(UTC)
    # Every request locks peer then account, never the reverse.
    for key, limit in [
        ("peer:" + peer, settings.login_peer_limit),
        ("account:" + username, settings.login_account_limit),
    ]:
        if not await _consume(session, fingerprint(key), limit, now, settings.login_window_seconds):
            return LoginResult(status_code=429)
    employee = await session.scalar(
        select(Employee).where(Employee.login == username).with_for_update()
    )
    stored = employee.password_hash if employee is not None else None
    valid = await to_thread.run_sync(verify_secret, stored, secret, limiter=limiter)
    if not valid or employee is None or not employee.is_active:
        return LoginResult()
    token = new_token()
    expires_at = now + timedelta(seconds=settings.session_ttl_seconds)
    session.add(
        AuthSession(
            employee_id=employee.id,
            token_hash=fingerprint(token),
            created_at=now,
            expires_at=expires_at,
        )
    )
    return LoginResult(token=token, expires_at=expires_at, status_code=200)
