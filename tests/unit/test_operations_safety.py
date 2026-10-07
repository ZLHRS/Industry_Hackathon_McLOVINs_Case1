"""Safety boundaries for the destructive actions confined to recovery resources."""

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "verify_operations", Path(__file__).resolve().parents[2] / "scripts/verify_operations.py"
)
assert _spec and _spec.loader
verify_operations = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(verify_operations)


def fixture_backup(tmp_path, monkeypatch):
    monkeypatch.setattr(verify_operations, "ROOT", tmp_path)
    backup = tmp_path / "var/backups/example"
    backup.mkdir(parents=True)
    (backup / "database.dump").write_bytes(b"fixture dump")
    (backup / "photos.tar.gz").write_bytes(b"fixture photos")
    (backup / "manifest.json").write_text(
        json.dumps(
            {
                "database_sha256": hashlib.sha256(b"fixture dump").hexdigest(),
                "photos_sha256": hashlib.sha256(b"fixture photos").hexdigest(),
            }
        )
    )
    return backup


def test_restore_refuses_corruption_and_external_backup_path(tmp_path, monkeypatch):
    backup = fixture_backup(tmp_path, monkeypatch)
    assert verify_operations.backup_path(backup) == backup
    (backup / "database.dump").write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="hash"):
        verify_operations.backup_path(backup)
    with pytest.raises(ValueError, match="private"):
        verify_operations.backup_path(tmp_path)


def test_restore_refuses_symlinked_input(tmp_path, monkeypatch):
    backup = fixture_backup(tmp_path, monkeypatch)
    external = tmp_path / "external"
    external.write_bytes(b"fixture dump")
    (backup / "database.dump").unlink()
    (backup / "database.dump").symlink_to(external)
    with pytest.raises(ValueError, match="regular files"):
        verify_operations.backup_path(backup)


def test_cleanup_cannot_target_production_even_with_valid_network(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Unsafe cleanup reached subprocess")

    monkeypatch.setattr(verify_operations.subprocess, "run", forbidden)
    with pytest.raises(ValueError, match="non-recovery"):
        verify_operations.cleanup(["technaryad-api-1"], "technaryad-recovery-" + "a" * 12)
