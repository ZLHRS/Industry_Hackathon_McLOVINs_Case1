"""Run from the repository root: uv run python -m seeds.industrial --help."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy.exc import SQLAlchemyError

from naryadai.config import Settings
from naryadai.infrastructure.database import Database

from . import DEFAULT_SEED_SECRET
from .storage import ROOT, SeedError, maintain, status


def parse_anchor(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Use an ISO timestamp with UTC offset") from None
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("UTC offset is required")
    return parsed.astimezone(UTC)


async def run(args: argparse.Namespace) -> None:
    settings = Settings()
    if settings.database_url is None:
        raise SeedError("Configure the local database first")
    database = Database(settings.database_url.get_secret_value())
    temporary: Path | None = None
    try:
        if args.action == "status":
            print(
                json.dumps(await status(database, environment=settings.environment.value), indent=2)
            )
            return
        if args.action in {"preview-orders", "replace-orders", "restore-orders"}:
            from .orders import refresh_orders

            required_orders = {
                "replace-orders": "REPLACE-ORDERS",
                "restore-orders": "RESTORE-ORDERS",
            }
            if args.action in required_orders and args.confirm != required_orders[args.action]:
                raise SeedError("This action requires --confirm " + required_orders[args.action])
            backup = getattr(args, "backup", None)
            if args.action == "restore-orders" and backup is None:
                raise SeedError("restore-orders requires --backup /path/to/orders.json")
            if args.action != "restore-orders" and backup is not None:
                raise SeedError("--backup is only accepted with restore-orders")
            result_orders = await refresh_orders(
                database,
                environment=settings.environment.value,
                anchor=args.anchor,
                seed=args.seed,
                preview=args.action == "preview-orders",
                restore=backup,
            )
            print(json.dumps({"action": args.action, **result_orders}, indent=2))
            return
        required = {"replace": "REPLACE-LOCAL-DATA", "clear": "CLEAR-INDUSTRIAL"}
        if args.action in required and args.confirm != required[args.action]:
            raise SeedError("This action requires --confirm " + required[args.action])
        dataset = None
        secret = ""
        credentials = ROOT / "var" / "industrial-credentials.txt"
        if args.action != "clear":
            from .generator import generate_dataset

            dataset = generate_dataset(anchor=args.anchor, seed=args.seed)
            secret = os.environ.get("NARYADAI_SEED_SECRET") or DEFAULT_SEED_SECRET
            credentials.parent.mkdir(exist_ok=True, mode=0o700)
            temporary = credentials.with_name(".seed-credentials-" + uuid4().hex)
            with temporary.open("x", encoding="utf-8") as stream:
                temporary.chmod(0o600)
                stream.write("Local fictional dataset. Do not commit or publish this file.\n")
                stream.write("Password: " + secret + "\n\n")
                for person in dataset["employees"]:
                    stream.write(
                        f"{person['role']:10} {person['login']:24} {person['display_name']}\n"
                    )
        result = await maintain(
            database,
            action=args.action,
            environment=settings.environment.value,
            dataset=dataset,
            anchor=args.anchor.date(),
            seed=args.seed,
            secret=secret,
        )
        if result.changed and temporary is not None:
            temporary.replace(credentials)
        print(
            json.dumps(
                {
                    "action": args.action,
                    "changed": result.changed,
                    "counts": result.counts,
                    "backup": str(result.backup) if result.backup else None,
                    "credentials_file": str(credentials) if args.action != "clear" else None,
                },
                indent=2,
            )
        )
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        await database.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=[
            "status",
            "apply",
            "replace",
            "clear",
            "preview-orders",
            "replace-orders",
            "restore-orders",
        ],
    )
    parser.add_argument(
        "--anchor", type=parse_anchor, default=datetime.now(UTC).replace(microsecond=0)
    )
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--confirm")
    parser.add_argument(
        "--backup", type=Path, help="Private orders.json snapshot for restore-orders"
    )
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except (SeedError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    except SQLAlchemyError:
        print(
            "Database operation failed and was rolled back; check the local database.",
            file=sys.stderr,
        )
        return 2
    except OSError:
        print("File or backup operation failed; check disk space and permissions.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
