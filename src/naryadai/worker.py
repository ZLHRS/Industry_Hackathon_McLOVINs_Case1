"""Independent durable loops for notifications, push delivery and repair review."""

from __future__ import annotations

import argparse
import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from sqlalchemy.exc import SQLAlchemyError

from naryadai.ai import OpenAIReviewConfig
from naryadai.application.ai_reviews import process_ai_review_jobs
from naryadai.application.notification_engine import (
    NotificationPolicy,
    process_outbox,
    scan_deadlines,
)
from naryadai.application.push_delivery import deliver_push
from naryadai.config import Settings
from naryadai.infrastructure.database import Database
from naryadai.infrastructure.photo_store import PhotoStore

logger = logging.getLogger(__name__)
Delivery = Callable[..., Awaitable[int]]


def _policy(settings: Settings) -> NotificationPolicy:
    return NotificationPolicy(
        reminder_minutes=settings.reminder_minutes,
        acceptance_minutes=settings.acceptance_minutes,
        emergency_acceptance_minutes=settings.emergency_acceptance_minutes,
        overdue_repeat_minutes=settings.overdue_repeat_minutes,
        manager_escalation_minutes=settings.manager_escalation_minutes,
    )


async def _review_once(database: Database, *, settings: Settings, now: datetime) -> int:
    config = OpenAIReviewConfig(
        api_key=settings.ai_api_key,
        model=settings.ai_model,
        reasoning_effort=settings.ai_reasoning_effort,
        max_output_tokens=settings.ai_max_output_tokens,
        vision_enabled=settings.ai_vision_enabled,
        request_timeout_seconds=settings.ai_timeout_seconds,
        total_timeout_seconds=settings.ai_total_timeout_seconds,
    )
    photo_store = None
    if settings.ai_vision_enabled and settings.ai_api_key is not None:
        photo_store = PhotoStore(
            settings.photo_root,
            max_bytes=settings.photo_max_bytes,
            max_pixels=settings.photo_max_pixels,
            max_dimension=settings.photo_max_dimension,
            output_max_bytes=settings.photo_output_max_bytes,
        )
    return await process_ai_review_jobs(
        database,
        config=config,
        now=now,
        photo_store=photo_store,
        max_attempts=settings.ai_max_attempts,
        lease_seconds=settings.ai_lease_seconds,
        limit=1,
    )


async def run_once(
    database: Database,
    settings: Settings,
    *,
    deliver: Delivery = deliver_push,
    review: Delivery = _review_once,
    now: datetime | None = None,
) -> int:
    """Run one bounded policy and delivery pass concurrently for deterministic tests."""

    instant = now or datetime.now(UTC)
    processed, scheduled, pushed, reviewed = await asyncio.gather(
        process_outbox(database, now=instant),
        scan_deadlines(database, now=instant, policy=_policy(settings)),
        deliver(database, settings=settings, now=instant),
        review(database, settings=settings, now=instant),
    )
    return processed + scheduled + pushed + reviewed


async def _outbox_loop(database: Database, settings: Settings) -> None:
    """Do not let a full deadline scan delay committed workflow changes."""
    while True:
        try:
            await process_outbox(database, now=datetime.now(UTC))
        except SQLAlchemyError:
            logger.error("outbox database pass failed; retrying")
        await asyncio.sleep(settings.worker_interval_seconds)


async def _deadline_loop(database: Database, settings: Settings) -> None:
    """Schedule deadline reminders independently from live workflow fanout."""
    while True:
        try:
            await scan_deadlines(database, now=datetime.now(UTC), policy=_policy(settings))
        except SQLAlchemyError:
            logger.error("deadline database pass failed; retrying")
        await asyncio.sleep(settings.worker_interval_seconds)


async def _push_loop(database: Database, settings: Settings, deliver: Delivery) -> None:
    """Run push leases separately so slow endpoints cannot delay deadline policy."""

    while True:
        try:
            await deliver(database, settings=settings, now=datetime.now(UTC))
        except SQLAlchemyError:
            logger.exception("push delivery database pass failed; retrying")
        await asyncio.sleep(settings.worker_interval_seconds)


async def _ai_loop(database: Database, settings: Settings, review: Delivery) -> None:
    """A slow model must never delay deadlines, inbox fanout or push delivery."""
    while True:
        try:
            await review(database, settings=settings, now=datetime.now(UTC))
        except SQLAlchemyError:
            # No exception payload: driver details may contain repair evidence.
            logger.error("AI review database pass failed; retrying")
        await asyncio.sleep(settings.worker_interval_seconds)


async def run_worker(
    database: Database,
    settings: Settings,
    *,
    deliver: Delivery = deliver_push,
    review: Delivery = _review_once,
) -> None:
    """Run durable notification policy and outbound delivery until cancelled."""

    async with asyncio.TaskGroup() as tasks:
        tasks.create_task(_outbox_loop(database, settings))
        tasks.create_task(_deadline_loop(database, settings))
        tasks.create_task(_push_loop(database, settings, deliver))
        tasks.create_task(_ai_loop(database, settings, review))


async def _serve(settings: Settings, *, once: bool) -> None:
    if settings.database_url is None:
        raise RuntimeError("NARYADAI_DATABASE_URL is required for the worker")
    database = Database(settings.database_url.get_secret_value())
    try:
        if once:
            await run_once(database, settings)
        else:
            await run_worker(database, settings)
    finally:
        await database.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    asyncio.run(_serve(Settings(), once=args.once))


if __name__ == "__main__":
    main()
