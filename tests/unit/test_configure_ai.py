"""Private key setup never echoes or stores malformed input."""

import importlib.util
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "configure_ai", Path(__file__).resolve().parents[2] / "scripts/configure_ai.py"
)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


def test_key_rotation_is_private_atomic_and_silent(tmp_path: Path, capsys) -> None:
    path = _MODULE.save_key(tmp_path, "sk-" + "a" * 40)
    _MODULE.save_key(tmp_path, "sk-" + "b" * 40)
    assert path.read_text() == "sk-" + "b" * 40 + "\n"
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    assert list(path.parent.iterdir()) == [path]
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize("value", ["", "short", "sk-" + "a " * 40])
def test_rejects_invalid_input_without_destroying_old_key(tmp_path: Path, value: str) -> None:
    path = _MODULE.save_key(tmp_path, "sk-" + "a" * 40)
    before = path.read_bytes()
    with pytest.raises(ValueError):
        _MODULE.save_key(tmp_path, value)
    assert path.read_bytes() == before
