"""Worker-loop and notification-policy boundaries."""

import asyncio
from contextlib import suppress
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import SQLAlchemyError

from naryadai import worker
from naryadai.application.notification_engine import NotificationPolicy


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        reminder_minutes=30,
        acceptance_minutes=10,
        emergency_acceptance_minutes=3,
        overdue_repeat_minutes=30,
        manager_escalation_minutes=60,
        worker_interval_seconds=0.001,
    )


def test_policy_rejects_nonpositive_intervals() -> None:
    with pytest.raises(ValueError, match="intervals must be positive"):
        NotificationPolicy(overdue_repeat_minutes=0)


@pytest.mark.asyncio
async def test_worker_policy_loop_runs_while_push_is_slow(monkeypatch) -> None:
    database_passed = asyncio.Event()
    release_push = asyncio.Event()

    async def outbox(*_args, **_kwargs) -> int:
        database_passed.set()
        return 0

    async def deadlines(*_args, **_kwargs) -> int:
        return 0

    async def slow_push(*_args, **_kwargs) -> int:
        await release_push.wait()
        return 0

    monkeypatch.setattr(worker, "process_outbox", outbox)
    monkeypatch.setattr(worker, "scan_deadlines", deadlines)
    task = asyncio.create_task(worker.run_worker(object(), _settings(), deliver=slow_push))
    try:
        await asyncio.wait_for(database_passed.wait(), timeout=0.2)
    finally:
        release_push.set()
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_worker_retries_transient_database_error(monkeypatch) -> None:
    attempts = 0
    recovered = asyncio.Event()
    release_push = asyncio.Event()

    async def flaky_outbox(*_args, **_kwargs) -> int:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise SQLAlchemyError("temporary database failure")
        recovered.set()
        return 0

    async def deadlines(*_args, **_kwargs) -> int:
        return 0

    async def push(*_args, **_kwargs) -> int:
        await release_push.wait()
        return 0

    monkeypatch.setattr(worker, "process_outbox", flaky_outbox)
    monkeypatch.setattr(worker, "scan_deadlines", deadlines)
    task = asyncio.create_task(worker.run_worker(object(), _settings(), deliver=push))
    try:
        await asyncio.wait_for(recovered.wait(), timeout=0.2)
        assert attempts >= 2
    finally:
        release_push.set()
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
