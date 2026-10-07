"""Back up Docker data and verify DB restore in a disposable network-isolated container."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tarfile
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ["docker", "compose", "--env-file", ".env.docker", "-f", "compose.yaml"]
COUNTS = (
    "SELECT 'orders',count(*) FROM work_orders UNION ALL "
    "SELECT 'events',count(*) FROM work_order_events UNION ALL "
    "SELECT 'photos',count(*) FROM photos UNION ALL "
    "SELECT 'materials',count(*) FROM material_usages ORDER BY 1;"
)


def run(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    # Captured diagnostics can contain connection information; never echo them.
    result = subprocess.run(args, cwd=ROOT, stderr=subprocess.PIPE, check=False, **kwargs)
    if result.returncode:
        raise RuntimeError("Backup/restore command failed; production data was not changed.")
    return result


def capture(args: list[str]) -> str:
    return run(args, stdout=subprocess.PIPE).stdout.decode().strip()


def verify_photo_archive(path: Path, records: list[dict]) -> dict[str, int]:
    """Verify bytes against the restored DB, without extracting untrusted tar paths."""
    expected = {row["storage_key"]: row for row in records}
    found: set[str] = set()
    verified = 0
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            if member.isdir() and member.name in {".", "./"}:
                continue
            name = member.name.removeprefix("./")
            try:
                safe = str(UUID(name.removesuffix(".jpg"))) + ".jpg" == name
            except ValueError:
                safe = False
            if not member.isfile() or not safe or name in found:
                raise RuntimeError("Photo archive contains an unsafe or duplicate entry.")
            found.add(name)
            row = expected.get(name)
            if row is None:
                continue  # A write concurrent with the DB snapshot can leave an extra file.
            if member.size != row["size_bytes"]:
                raise RuntimeError("Restored photo size differs from database metadata.")
            stream = archive.extractfile(member)
            if stream is None:
                raise RuntimeError("A referenced photo cannot be read from the backup.")
            with stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != row["sha256"]:
                raise RuntimeError("Restored photo hash differs from database metadata.")
            verified += 1
    if expected.keys() - found:
        raise RuntimeError("Photo backup is missing files referenced by the restored database.")
    return {
        "archive_files": len(found),
        "verified_references": verified,
        "unreferenced_files": len(found - expected.keys()),
    }


def main() -> None:
    os.umask(0o077)
    destination = ROOT / "var/backups" / datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    destination.mkdir(parents=True, mode=0o700)
    dump = destination / "database.dump"
    photos = destination / "photos.tar.gz"
    query = ["psql", "-U", "naryadai", "-d", "naryadai", "-At", "-c", COUNTS]
    source_counts = capture([*COMPOSE, "exec", "-T", "postgres", *query])
    with dump.open("xb") as stream:
        run(
            [
                *COMPOSE,
                "exec",
                "-T",
                "postgres",
                "pg_dump",
                "-U",
                "naryadai",
                "-d",
                "naryadai",
                "-Fc",
            ],
            stdout=stream,
        )
    with photos.open("xb") as stream:
        run(
            [*COMPOSE, "exec", "-T", "api", "tar", "-C", "/app/var/photos", "-czf", "-", "."],
            stdout=stream,
        )
    image = capture([*COMPOSE, "images", "-q", "postgres"])
    container = "technaryad-restore-check-" + uuid4().hex[:10]
    started = False
    try:
        # Trust applies only inside this disposable container: no network or published port.
        run(
            [
                "docker",
                "run",
                "-d",
                "--rm",
                "--network",
                "none",
                "--name",
                container,
                "-e",
                "POSTGRES_HOST_AUTH_METHOD=trust",
                "-e",
                "POSTGRES_USER=naryadai",
                "-e",
                "POSTGRES_DB=naryadai",
                image,
            ],
            stdout=subprocess.DEVNULL,
        )
        started = True
        for _ in range(40):
            check = subprocess.run(
                ["docker", "exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "naryadai"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if check.returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Isolated restore database did not start.")
        with dump.open("rb") as stream:
            run(
                [
                    "docker",
                    "exec",
                    "-i",
                    container,
                    "pg_restore",
                    "-U",
                    "naryadai",
                    "-d",
                    "naryadai",
                    "--no-owner",
                    "--no-privileges",
                    "--exit-on-error",
                ],
                stdin=stream,
                stdout=subprocess.DEVNULL,
            )
        restored_counts = capture(["docker", "exec", container, *query])
        if restored_counts != source_counts:
            raise RuntimeError(
                "Snapshot counts differ: source may have changed during backup. "
                "Retry in a quiet window."
            )
        photo_rows = json.loads(
            capture(
                [
                    "docker",
                    "exec",
                    container,
                    "psql",
                    "-U",
                    "naryadai",
                    "-d",
                    "naryadai",
                    "-At",
                    "-c",
                    "SELECT coalesce(json_agg(p),'[]'::json) FROM "
                    "(SELECT storage_key,sha256,size_bytes FROM photos) p;",
                ]
            )
        )
        photo_integrity = verify_photo_archive(photos, photo_rows)
        result = {
            "created_at": datetime.now(UTC).isoformat(),
            "database_restore": "passed",
            "counts": restored_counts.splitlines(),
            "photo_archive_files": photo_integrity["archive_files"],
            "photo_integrity": photo_integrity,
            "database_sha256": hashlib.sha256(dump.read_bytes()).hexdigest(),
            "photos_sha256": hashlib.sha256(photos.read_bytes()).hexdigest(),
            "scope": "Database restored with constraints; every referenced photo verified by "
            "size and SHA-256 against restored metadata. "
            "Role grants, secrets and full service recovery require the deployment runbook.",
        }
        (destination / "manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(
            json.dumps(
                {"backup_directory": str(destination.relative_to(ROOT)), **result},
                ensure_ascii=False,
            )
        )
    finally:
        if started:
            subprocess.run(
                ["docker", "rm", "-f", container],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
