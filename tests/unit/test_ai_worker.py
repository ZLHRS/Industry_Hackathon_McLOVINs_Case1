"""The AI transport must not stall independent notification work."""

import asyncio
from contextlib import suppress
from datetime import UTC, datetime

import pytest
from pydantic import SecretStr
from sqlalchemy.exc import SQLAlchemyError

from naryadai import worker
from naryadai.config import Settings


@pytest.mark.asyncio
async def test_slow_ai_does_not_block_deadlines_or_delivery(monkeypatch):
    policy = asyncio.Event()
    pushed = asyncio.Event()
    reviewing = asyncio.Event()
    release = asyncio.Event()

    async def outbox(*args, **kwargs):
        policy.set()
        return 0

    async def push(*args, **kwargs):
        pushed.set()
        return 0

    async def slow_review(*args, **kwargs):
        reviewing.set()
        await release.wait()
        return 0

    monkeypatch.setattr(worker, "process_outbox", outbox)
    monkeypatch.setattr(worker, "scan_deadlines", outbox)
    task = asyncio.create_task(
        worker.run_worker(object(), Settings(), deliver=push, review=slow_review)
    )
    try:
        await asyncio.wait_for(asyncio.gather(policy.wait(), pushed.wait(), reviewing.wait()), 1)
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_ai_database_error_is_retried_without_logging_payload(caplog):
    recovered = asyncio.Event()
    calls = 0

    async def review(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise SQLAlchemyError("private repair evidence")
        recovered.set()
        return 0

    task = asyncio.create_task(
        worker._ai_loop(object(), Settings(worker_interval_seconds=0.1), review)
    )
    try:
        await asyncio.wait_for(recovered.wait(), 1)
        assert calls == 2
        assert "private repair evidence" not in caplog.text
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
@pytest.mark.parametrize("vision", [False, True])
async def test_review_pass_builds_bounded_configuration(monkeypatch, tmp_path, vision):
    async def process(database, **kwargs):
        assert kwargs["limit"] == 1
        assert kwargs["config"].model == "gpt-6.1-sol"
        assert kwargs["config"].reasoning_effort == "medium"
        assert kwargs["config"].max_output_tokens == 8192
        assert kwargs["lease_seconds"] > kwargs["config"].total_timeout_seconds
        assert kwargs["max_attempts"] == 3
        assert (kwargs["photo_store"] is not None) == vision
        assert kwargs["config"].api_key.get_secret_value() == "local-fixture"
        return 1

    monkeypatch.setattr(worker, "process_ai_review_jobs", process)
    settings = Settings(
        ai_api_key=SecretStr("local-fixture"),
        ai_vision_enabled=vision,
        photo_root=tmp_path / "photos",
    )
    assert await worker._review_once(object(), settings=settings, now=datetime.now(UTC)) == 1


@pytest.mark.asyncio
async def test_worker_once_sums_independent_passes(monkeypatch):
    async def count(*args, **kwargs):
        return 1

    monkeypatch.setattr(worker, "process_outbox", count)
    monkeypatch.setattr(worker, "scan_deadlines", count)
    assert await worker.run_once(object(), Settings(), deliver=count, review=count) == 4
