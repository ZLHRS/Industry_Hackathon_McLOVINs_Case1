"""Explicit command-line entrypoint for the synthetic NaryadAI demo seed."""

from __future__ import annotations

import argparse
import asyncio
import os
from collections.abc import Sequence
from datetime import date

from naryadai.config import Settings
from naryadai.infrastructure.database import Database

from .persist import SeedRefusalError, seed_demo_database

_DEFAULT_ANCHOR = date(2026, 10, 5)


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("anchor must use YYYY-MM-DD") from error


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Seed an empty local NaryadAI demo database")
    parser.add_argument(
        "--anchor",
        type=_parse_date,
        default=_DEFAULT_ANCHOR,
        help="calendar anchor in YYYY-MM-DD format (default: 2026-10-05)",
    )
    parser.add_argument("--seed", type=int, default=42, help="deterministic generator seed")
    return parser


async def _run(anchor: date, seed: int, secret: str) -> int:
    settings = Settings()
    if settings.database_url is None:
        raise SeedRefusalError("NARYADAI_DATABASE_URL is required")
    database = Database(settings.database_url.get_secret_value())
    try:
        result = await seed_demo_database(
            database,
            anchor_date=anchor,
            seed=seed,
            secret=secret,
            environment=settings.environment.value,
        )
    finally:
        await database.dispose()
    state = "already seeded" if result.already_seeded else "seeded"
    print(f"Synthetic demo database {state}: anchor={anchor.isoformat()}, seed={seed}")
    print("Demo logins: demo.master1, demo.master2, demo.executor01..15, demo.manager, demo.admin")
    print(", ".join(f"{name}={count}" for name, count in result.counts.items()))
    print("Photos: 0 (intentionally omitted until real private storage is available).")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    secret = os.environ.get("NARYADAI_DEMO_SECRET")
    if secret is None:
        _parser().error("NARYADAI_DEMO_SECRET is required")
    try:
        return asyncio.run(_run(args.anchor, args.seed, secret))
    except SeedRefusalError as error:
        print(f"Demo seed refused: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
