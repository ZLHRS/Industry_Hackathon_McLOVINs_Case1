"""A readable photo archive is insufficient: it must match the DB snapshot."""

import hashlib
import importlib.util
import io
import tarfile
from pathlib import Path
from uuid import uuid4

import pytest

_spec = importlib.util.spec_from_file_location(
    "backup_restore", Path(__file__).resolve().parents[2] / "scripts/backup_restore.py"
)
assert _spec and _spec.loader
backup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(backup)


def archive(tmp_path, entries):
    path = tmp_path / "photos.tar.gz"
    with tarfile.open(path, "w:gz") as stream:
        for name, content, kind in entries:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = len(content) if kind == tarfile.REGTYPE else 0
            stream.addfile(info, io.BytesIO(content) if kind == tarfile.REGTYPE else None)
    return path


def test_photo_backup_checks_referenced_bytes_and_allows_snapshot_orphans(tmp_path):
    name, orphan = f"{uuid4()}.jpg", f"{uuid4()}.jpg"
    content = b"a private normalized photo"
    path = archive(
        tmp_path,
        [
            ("./" + name, content, tarfile.REGTYPE),
            (orphan, b"later upload", tarfile.REGTYPE),
        ],
    )
    result = backup.verify_photo_archive(
        path,
        [
            {
                "storage_key": name,
                "sha256": hashlib.sha256(content).hexdigest(),
                "size_bytes": len(content),
            }
        ],
    )
    assert result == {"archive_files": 2, "verified_references": 1, "unreferenced_files": 1}


@pytest.mark.parametrize("mismatch", ["missing", "hash", "size"])
def test_photo_backup_rejects_incomplete_or_corrupt_evidence(tmp_path, mismatch):
    name = f"{uuid4()}.jpg"
    path = archive(tmp_path, [] if mismatch == "missing" else [(name, b"photo", tarfile.REGTYPE)])
    with pytest.raises(RuntimeError):
        backup.verify_photo_archive(
            path,
            [
                {
                    "storage_key": name,
                    "sha256": "0" * 64
                    if mismatch == "hash"
                    else hashlib.sha256(b"photo").hexdigest(),
                    "size_bytes": 42 if mismatch == "size" else 5,
                }
            ],
        )


@pytest.mark.parametrize(
    "name,kind",
    [
        ("../outside.jpg", tarfile.REGTYPE),
        ("/tmp/outside.jpg", tarfile.REGTYPE),
        (f"{uuid4()}.jpg", tarfile.SYMTYPE),
    ],
)
def test_photo_backup_rejects_unsafe_members(tmp_path, name, kind):
    path = archive(tmp_path, [(name, b"photo", kind)])
    with pytest.raises(RuntimeError, match="unsafe"):
        backup.verify_photo_archive(path, [])
