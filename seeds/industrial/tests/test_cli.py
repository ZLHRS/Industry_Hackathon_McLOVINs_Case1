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
@pytest.mark.parametrize("configured", [None, "CustomSeedPass2026!"])
async def test_cli_stores_private_credential_without_printing_or_rotating_it(
    database, monkeypatch, tmp_path, capsys, configured
):
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setenv(
        "NARYADAI_DATABASE_URL", database.engine.url.render_as_string(hide_password=False)
    )
    monkeypatch.setenv("NARYADAI_ENVIRONMENT", "test")
    monkeypatch.delenv("NARYADAI_SEED_SECRET", raising=False)
    if configured is not None:
        monkeypatch.setenv("NARYADAI_SEED_SECRET", configured)
    await cli.run(args())
    credentials = tmp_path / "var/industrial-credentials.txt"
    original = credentials.read_text()
    password = next(
        line.removeprefix("Password: ")
        for line in original.splitlines()
        if line.startswith("Password: ")
    )
    assert password == (configured or "TechNaryad2026!")
    assert password not in capsys.readouterr().out
    assert credentials.stat().st_mode & 0o777 == 0o600
    async with database.sessions() as session:
        stored = await session.scalar(select(Employee.password_hash))
    assert verify_secret(stored, password)
    monkeypatch.setenv("NARYADAI_SEED_SECRET", "ChangedButNotApplied2026!")
    await cli.run(args())
    assert credentials.read_text() == original
    async with database.sessions() as session:
        stored_after = await session.scalar(select(Employee.password_hash))
    assert stored_after == stored
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
