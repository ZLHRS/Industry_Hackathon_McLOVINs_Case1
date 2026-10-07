"""Docker preparation preserves credentials across restarts and rebuilds."""

import importlib.util
from pathlib import Path

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
    settings = tmp_path / ".env.docker"
    settings.write_text("NARYADAI_HTTP_PORT=8088\n")
    _MODULE.prepare(tmp_path)
    assert settings.read_text() == "NARYADAI_HTTP_PORT=8088\n"
    assert before == {path.name: path.read_bytes() for path in paths}
    output = capsys.readouterr().out
    assert all(secret.decode().strip() not in output for secret in before.values())
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in paths)
    assert (tmp_path / "var/docker/secrets").stat().st_mode & 0o777 == 0o700
