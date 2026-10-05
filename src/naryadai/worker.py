"""Notification worker entry point; policy and network delivery run independently."""

from __future__ import annotations

import argparse
import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from sqlalchemy.exc import SQLAlchemyError

from naryadai.application.notification_engine import (
    NotificationPolicy,
    process_outbox,
    scan_deadlines,
)
from naryadai.application.push_delivery import deliver_push
from naryadai.config import Settings
from naryadai.infrastructure.database import Database

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


async def run_once(
    database: Database,
    settings: Settings,
    *,
    deliver: Delivery = deliver_push,
    now: datetime | None = None,
) -> int:
    """Run one bounded policy and delivery pass concurrently for deterministic tests."""

    instant = now or datetime.now(UTC)
    processed, scheduled, pushed = await asyncio.gather(
        process_outbox(database, now=instant),
        scan_deadlines(database, now=instant, policy=_policy(settings)),
        deliver(database, settings=settings, now=instant),
    )
    return processed + scheduled + pushed


async def _database_loop(database: Database, settings: Settings) -> None:
    """Run transactional inbox work without waiting for network push requests."""

    while True:
        instant = datetime.now(UTC)
        try:
            await asyncio.gather(
                process_outbox(database, now=instant),
                scan_deadlines(database, now=instant, policy=_policy(settings)),
            )
        except SQLAlchemyError:
            logger.exception("notification policy database pass failed; retrying")
        await asyncio.sleep(settings.worker_interval_seconds)


async def _push_loop(database: Database, settings: Settings, deliver: Delivery) -> None:
    """Run push leases separately so slow endpoints cannot delay deadline policy."""

    while True:
        try:
            await deliver(database, settings=settings, now=datetime.now(UTC))
        except SQLAlchemyError:
            logger.exception("push delivery database pass failed; retrying")
        await asyncio.sleep(settings.worker_interval_seconds)


async def run_worker(
    database: Database, settings: Settings, *, deliver: Delivery = deliver_push
) -> None:
    """Run durable notification policy and outbound delivery until cancelled."""

    async with asyncio.TaskGroup() as tasks:
        tasks.create_task(_database_loop(database, settings))
        tasks.create_task(_push_loop(database, settings, deliver))


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
