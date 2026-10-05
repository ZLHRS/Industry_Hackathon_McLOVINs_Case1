"""Keep tests independent of the developer's environment and .env file."""

import os
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolate_settings_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for key in os.environ:
        if key.startswith("NARYADAI_"):
            monkeypatch.delenv(key)
    monkeypatch.chdir(tmp_path)


def pytest_addoption(parser):
    parser.addoption(
        "--require-db", action="store_true", help="Fail if PostgreSQL tests cannot run"
    )
