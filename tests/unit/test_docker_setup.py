"""Docker preparation preserves credentials across restarts and rebuilds."""

import importlib.util
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[2] / "scripts/docker_setup.py"
_SPEC = importlib.util.spec_from_file_location("docker_setup", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


def test_prepare_preserves_existing_secrets_and_custom_settings(tmp_path: Path, capsys) -> None:
    _MODULE.prepare(tmp_path)
    paths = list((tmp_path / "var/docker/secrets").iterdir())
    before = {path.name: path.read_bytes() for path in paths}
    assert len(before) == 3
    assert len(set(before.values())) == 3
    assert before["demo_password"] == b"TechNaryad2026!\n"
    settings = tmp_path / ".env.docker"
    settings.write_text("NARYADAI_HTTP_PORT=8088\n")
    _MODULE.prepare(tmp_path)
    assert settings.read_text() == "NARYADAI_HTTP_PORT=8088\n"
    assert before == {path.name: path.read_bytes() for path in paths}
    output = capsys.readouterr().out
    assert all(secret.decode().strip() not in output for secret in before.values())
    assert all(path.stat().st_mode & 0o777 == 0o444 for path in paths)
    assert (tmp_path / "var/docker/secrets").stat().st_mode & 0o777 == 0o700
    assert settings.stat().st_mode & 0o777 == 0o600


def test_prepare_rejects_empty_secret_directory_without_writing_other_files(tmp_path: Path) -> None:
    directory = tmp_path / "var/docker/secrets"
    (directory / "postgres_password").mkdir(parents=True)

    with pytest.raises(_MODULE.SecretPathError, match="empty directory"):
        _MODULE.prepare(tmp_path)

    assert (directory / "postgres_password").is_dir()
    assert not (directory / "app_password").exists()
    assert not (directory / "demo_password").exists()
    assert not (tmp_path / ".env.docker").exists()


def test_prepare_repairs_only_empty_secret_directories_when_explicitly_requested(
    tmp_path: Path,
) -> None:
    directory = tmp_path / "var/docker/secrets"
    (directory / "postgres_password").mkdir(parents=True)
    existing_app_password = directory / "app_password"
    existing_app_password.write_text("keep-this-password\n")

    _MODULE.prepare(tmp_path, repair_empty_secret_dirs=True)

    paths = {path.name: path for path in directory.iterdir()}
    assert set(paths) == {"postgres_password", "app_password", "demo_password"}
    assert all(path.is_file() and path.stat().st_size > 0 for path in paths.values())
    assert existing_app_password.read_text() == "keep-this-password\n"
    assert paths["demo_password"].read_text() == "TechNaryad2026!\n"


@pytest.mark.parametrize(
    ("kind", "error"),
    [
        ("empty_file", "empty file"),
        ("nonempty_directory", "non-empty directory"),
        ("symlink", "symbolic link"),
    ],
)
def test_prepare_rejects_invalid_secret_paths_without_partial_overwrite(
    tmp_path: Path, kind: str, error: str
) -> None:
    directory = tmp_path / "var/docker/secrets"
    directory.mkdir(parents=True)
    problem_path = directory / "postgres_password"
    if kind == "empty_file":
        problem_path.touch()
    elif kind == "nonempty_directory":
        problem_path.mkdir()
        (problem_path / "keep").write_text("unchanged")
    else:
        target = tmp_path / "secret-target"
        target.write_text("not read")
        problem_path.symlink_to(target)

    with pytest.raises(_MODULE.SecretPathError, match=error):
        _MODULE.prepare(tmp_path, repair_empty_secret_dirs=True)

    assert not (directory / "app_password").exists()
    assert not (directory / "demo_password").exists()
    assert not (tmp_path / ".env.docker").exists()
    if kind == "empty_file":
        assert problem_path.read_bytes() == b""
    elif kind == "nonempty_directory":
        assert (problem_path / "keep").read_text() == "unchanged"
    else:
        assert problem_path.is_symlink()


@pytest.mark.parametrize(
    ("contents", "error"),
    [
        (b" \t\n", "blank file"),
        (b"bad\0secret", "binary file"),
        (b"\xff", "unreadable UTF-8 text file"),
    ],
)
def test_prepare_rejects_nonusable_secret_file_without_writing_other_files(
    tmp_path: Path, contents: bytes, error: str
) -> None:
    directory = tmp_path / "var/docker/secrets"
    directory.mkdir(parents=True)
    problem_path = directory / "postgres_password"
    problem_path.write_bytes(contents)

    with pytest.raises(_MODULE.SecretPathError, match=error):
        _MODULE.prepare(tmp_path)

    assert problem_path.read_bytes() == contents
    assert not (directory / "app_password").exists()
    assert not (directory / "demo_password").exists()
    assert not (tmp_path / ".env.docker").exists()


@pytest.mark.parametrize(
    ("kind", "error"),
    [("directory", "directory"), ("symlink", "symbolic link")],
)
def test_prepare_rejects_invalid_settings_path_before_writing_secrets(
    tmp_path: Path, kind: str, error: str
) -> None:
    settings = tmp_path / ".env.docker"
    if kind == "directory":
        settings.mkdir()
    else:
        target = tmp_path / "settings-target"
        target.write_text("NARYADAI_HTTP_PORT=8080\n")
        settings.symlink_to(target)

    with pytest.raises(_MODULE.SecretPathError, match=error):
        _MODULE.prepare(tmp_path)

    directory = tmp_path / "var/docker/secrets"
    assert not (directory / "postgres_password").exists()
    assert not (directory / "app_password").exists()
    assert not (directory / "demo_password").exists()


def test_prepare_rejects_secret_directory_symlink(tmp_path: Path) -> None:
    directory = tmp_path / "var/docker/secrets"
    directory.parent.mkdir(parents=True)
    target = tmp_path / "secret-target"
    target.mkdir()
    directory.symlink_to(target, target_is_directory=True)

    with pytest.raises(_MODULE.SecretPathError, match="symbolic link"):
        _MODULE.prepare(tmp_path)

    assert directory.is_symlink()
    assert not (tmp_path / ".env.docker").exists()


def test_prepare_does_not_change_permissions_when_secret_validation_fails(tmp_path: Path) -> None:
    directory = tmp_path / "var/docker/secrets"
    directory.mkdir(parents=True)
    directory.chmod(0o755)
    invalid = directory / "postgres_password"
    invalid.touch()
    invalid.chmod(0o600)

    with pytest.raises(_MODULE.SecretPathError, match="empty file"):
        _MODULE.prepare(tmp_path)

    assert directory.stat().st_mode & 0o777 == 0o755
    assert invalid.stat().st_mode & 0o777 == 0o600


def test_prepare_preserves_optional_secret_values_and_normalizes_their_permissions(
    tmp_path: Path,
) -> None:
    directory = tmp_path / "var/docker/secrets"
    directory.mkdir(parents=True)
    directory.chmod(0o755)
    optional_secrets = {
        "ai_api_key": "optional-ai-key\n",
        "vapid_private.pem": "optional-vapid-key\n",
    }
    for name, value in optional_secrets.items():
        path = directory / name
        path.write_text(value)
        path.chmod(0o600)

    _MODULE.prepare(tmp_path)

    for name, value in optional_secrets.items():
        path = directory / name
        assert path.read_text() == value
        assert path.stat().st_mode & 0o777 == 0o444
    assert directory.stat().st_mode & 0o777 == 0o700
