import argparse
from datetime import UTC, datetime

import pytest
from seeds.industrial import __main__ as cli
from seeds.industrial.storage import SeedError
from sqlalchemy import select

from naryadai.auth.security import verify_secret
from naryadai.infrastructure.models import Employee


def args(action="apply", confirm=None):
    return argparse.Namespace(
        action=action, anchor=datetime(2026, 10, 6, 12, tzinfo=UTC), seed=2026, confirm=confirm
    )


@pytest.mark.asyncio
async def test_cli_stores_private_credential_without_printing_or_rotating_it(
    database, monkeypatch, tmp_path, capsys
):
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setenv(
        "NARYADAI_DATABASE_URL", database.engine.url.render_as_string(hide_password=False)
    )
    monkeypatch.setenv("NARYADAI_ENVIRONMENT", "test")
    monkeypatch.delenv("NARYADAI_SEED_SECRET", raising=False)
    await cli.run(args())
    credentials = tmp_path / "var/industrial-credentials.txt"
    original = credentials.read_text()
    password = next(
        line.removeprefix("Password: ")
        for line in original.splitlines()
        if line.startswith("Password: ")
    )
    assert password not in capsys.readouterr().out
    assert credentials.stat().st_mode & 0o777 == 0o600
    async with database.sessions() as session:
        stored = await session.scalar(select(Employee.password_hash))
    assert verify_secret(stored, password)
    await cli.run(args())
    assert credentials.read_text() == original
    assert not list(credentials.parent.glob(".seed-credentials-*"))


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["replace", "clear"])
async def test_cli_requires_explicit_destructive_token(database, monkeypatch, tmp_path, action):
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setenv(
        "NARYADAI_DATABASE_URL", database.engine.url.render_as_string(hide_password=False)
    )
    monkeypatch.setenv("NARYADAI_ENVIRONMENT", "test")
    with pytest.raises(SeedError, match="requires --confirm"):
        await cli.run(args(action))
    assert not (tmp_path / "var/industrial-credentials.txt").exists()
