"""Protect local data when selecting installed development runtimes."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest

_PATH = Path(__file__).resolve().parents[2] / "scripts/dev_database.py"
_SPEC = importlib.util.spec_from_file_location("dev_database", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


def test_explicit_missing_runtime_does_not_fall_back_to_another_version(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("NARYADAI_PG_BIN", str(tmp_path / "missing"))
    with pytest.raises(SystemExit, match="binaries not found"):
        _MODULE.postgres_runtime()


def test_cluster_version_mismatch_refuses_even_stop(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    data = tmp_path / "data"
    data.mkdir()
    (data / "PG_VERSION").write_text("16\n")
    monkeypatch.setattr(_MODULE, "BASE", tmp_path)
    monkeypatch.setattr(_MODULE, "DATA", data)
    monkeypatch.setattr(_MODULE.sys, "argv", ["dev_database.py", "stop"])
    monkeypatch.setattr(_MODULE, "postgres_runtime", lambda **_: (tmp_path, None))
    monkeypatch.setattr(
        _MODULE.subprocess,
        "check_output",
        lambda *a, **k: "postgres (PostgreSQL) 17.2 (Homebrew)\n",
    )
    run = Mock()
    monkeypatch.setattr(_MODULE, "run", run)
    with pytest.raises(SystemExit, match="Cluster major version differs"):
        _MODULE.main()
    run.assert_not_called()
    assert (data / "PG_VERSION").read_text() == "16\n"


def test_existing_cluster_without_password_is_never_reinitialized(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    data = tmp_path / "data"
    data.mkdir()
    (data / "PG_VERSION").write_text("17\n")
    monkeypatch.setattr(_MODULE, "BASE", tmp_path)
    monkeypatch.setattr(_MODULE, "DATA", data)
    monkeypatch.setattr(_MODULE.sys, "argv", ["dev_database.py", "start"])
    monkeypatch.setattr(_MODULE, "postgres_runtime", lambda **_: (tmp_path, None))
    monkeypatch.setattr(
        _MODULE.subprocess,
        "check_output",
        lambda *a, **k: "postgres (PostgreSQL) 17.2 (Homebrew)\n",
    )
    run = Mock()
    monkeypatch.setattr(_MODULE, "run", run)
    with pytest.raises(SystemExit, match="refusing to reset"):
        _MODULE.main()
    run.assert_not_called()
    assert not (tmp_path / "password").exists()


def test_macos_runtime_selection_matches_the_existing_cluster_major(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    pg16 = Path("/Library/PostgreSQL/16/bin")
    pg17 = Path("/Library/PostgreSQL/17/bin")
    monkeypatch.delenv("NARYADAI_PG_BIN", raising=False)
    monkeypatch.setattr(_MODULE.sys, "platform", "darwin")
    monkeypatch.setattr(_MODULE.shutil, "which", lambda _: None)
    monkeypatch.setattr(
        Path,
        "is_file",
        lambda path: path.parent in {pg16, pg17} and path.name in {"pg_ctl", "initdb"},
    )
    monkeypatch.setattr(
        _MODULE.subprocess,
        "check_output",
        lambda command, **_: "postgres (PostgreSQL) "
        + ("16.4" if str(pg16) in command[0] else "17.2"),
    )

    assert _MODULE.postgres_runtime(required_major="17") == (pg17, None)
    assert _MODULE.postgres_runtime(required_major="16") == (pg16, None)


def test_stop_is_idempotent_when_the_project_cluster_is_already_stopped(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    data = tmp_path / "data"
    data.mkdir()
    (data / "PG_VERSION").write_text("16\n")
    monkeypatch.setattr(_MODULE, "BASE", tmp_path)
    monkeypatch.setattr(_MODULE, "DATA", data)
    monkeypatch.setattr(_MODULE.sys, "argv", ["dev_database.py", "stop"])
    monkeypatch.setattr(_MODULE, "postgres_runtime", lambda **_: (tmp_path, None))
    monkeypatch.setattr(
        _MODULE.subprocess,
        "check_output",
        lambda *args, **kwargs: "postgres (PostgreSQL) 16.4\n",
    )
    monkeypatch.setattr(
        _MODULE.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=3)
    )
    run = Mock()
    monkeypatch.setattr(_MODULE, "run", run)

    _MODULE.main()

    run.assert_not_called()


@pytest.mark.parametrize("mismatch", ["password", "host", "shell"])
def test_application_configuration_mismatch_fails_without_exposing_secrets(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mismatch: str
) -> None:
    expected = "postgresql+psycopg://naryadai_app:private-value@127.0.0.1:55432/naryadai"
    wrong = expected.replace("private-value", "stale-value")
    if mismatch == "host":
        wrong = expected.replace("127.0.0.1", "remote.example")
    monkeypatch.setattr(_MODULE, "ROOT", tmp_path)
    monkeypatch.delenv("NARYADAI_DATABASE_URL", raising=False)
    (tmp_path / ".env").write_text("NARYADAI_DATABASE_URL='" + wrong + "'\n")
    if mismatch == "shell":
        (tmp_path / ".env").write_text("NARYADAI_DATABASE_URL='" + expected + "'\n")
        monkeypatch.setenv("NARYADAI_DATABASE_URL", wrong)
    connect = Mock()
    monkeypatch.setattr(_MODULE.psycopg, "connect", connect)
    with pytest.raises(SystemExit, match="does not match") as error:
        _MODULE.verify_application_connection(expected)
    assert "private-value" not in str(error.value)
    assert "stale-value" not in str(error.value)
    assert "postgresql" not in str(error.value)
    connect.assert_not_called()


def test_matching_quoted_configuration_checks_actual_login(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    expected = "postgresql+psycopg://naryadai_app:private-value@127.0.0.1:55432/naryadai"
    monkeypatch.setattr(_MODULE, "ROOT", tmp_path)
    monkeypatch.delenv("NARYADAI_DATABASE_URL", raising=False)
    (tmp_path / ".env").write_text("NARYADAI_DATABASE_URL='" + expected + "'\n")
    connect = MagicMock()
    monkeypatch.setattr(_MODULE.psycopg, "connect", connect)
    _MODULE.verify_application_connection(expected)
    connect.return_value.__enter__.return_value.execute.assert_called_once_with("SELECT 1")
    connect.side_effect = _MODULE.psycopg.OperationalError("private-value")
    with pytest.raises(SystemExit, match="login failed") as error:
        _MODULE.verify_application_connection(expected)
    assert "private-value" not in str(error.value)
