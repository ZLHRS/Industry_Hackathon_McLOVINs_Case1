"""Restore a backup into an internal Docker network and verify real service recovery.

No production containers are stopped. No host ports, AI keys, push keys or tunnel
credentials are attached to the disposable stack. Restore data never leaves it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.backup_restore import COMPOSE, COUNTS, verify_photo_archive  # noqa: E402

PREFIX = re.compile(r"^technaryad-recovery-[0-9a-f]{12}(?:-(?:db|api|web|worker|photos))?$")


def run(argv: list[str], *, data: bytes | None = None, timeout: int = 120) -> bytes:
    result = subprocess.run(
        argv,
        input=data,
        capture_output=True,
        cwd=ROOT,
        check=False,
        timeout=timeout,
    )
    if result.returncode:
        raise RuntimeError("isolated_command_failed")
    return result.stdout


def backup_path(path: Path) -> Path:
    resolved = path.resolve()
    if (ROOT / "var/backups").resolve() not in resolved.parents:
        raise ValueError("Backup must be an existing private var/backups child directory")
    for name in ("database.dump", "photos.tar.gz", "manifest.json"):
        candidate = resolved / name
        if not candidate.is_file() or candidate.is_symlink():
            raise ValueError("Backup requires regular files")
    manifest = json.loads((resolved / "manifest.json").read_text())
    for name, key in (("database.dump", "database_sha256"), ("photos.tar.gz", "photos_sha256")):
        if hashlib.sha256((resolved / name).read_bytes()).hexdigest() != manifest[key]:
            raise ValueError("Backup hash does not match its manifest")
    return resolved


def cleanup(names: list[str], network: str) -> bool:
    for name in [*names, network]:
        if not PREFIX.fullmatch(name):
            raise ValueError("Refusing cleanup of non-recovery resources")
    for name in reversed(names):
        subprocess.run(
            ["docker", "rm", "-fv", name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=30,
        )
    subprocess.run(
        ["docker", "network", "rm", network],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=30,
    )

    volume = network + "-photos"
    subprocess.run(
        ["docker", "volume", "rm", volume],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=30,
    )
    volumes = subprocess.run(
        ["docker", "volume", "ls", "-q", "--filter", "name=" + volume],
        capture_output=True,
        check=False,
        timeout=30,
    )
    remaining = subprocess.run(
        ["docker", "ps", "-aq", "--filter", "name=" + network],
        capture_output=True,
        check=False,
        timeout=30,
    )
    networks = subprocess.run(
        ["docker", "network", "ls", "-q", "--filter", "name=" + network],
        capture_output=True,
        check=False,
        timeout=30,
    )
    return (
        remaining.returncode == 0
        and networks.returncode == 0
        and volumes.returncode == 0
        and not volumes.stdout.strip()
        and not (remaining.stdout.strip() or networks.stdout.strip())
    )


def verify(path: Path, api_image: str, web_image: str, database_image: str) -> dict:
    path = backup_path(path)
    if not database_image:
        database_image = run([*COMPOSE, "images", "-q", "postgres"]).decode().strip()
    manifest = json.loads((path / "manifest.json").read_text())
    network = "technaryad-recovery-" + uuid4().hex[:12]
    names: list[str] = []
    stage = "prepare"
    result: dict = {
        "status": "FAIL",
        "created_at": datetime.now(UTC).isoformat(),
        "production_modified": False,
        "external_ai_or_push": False,
        "backup": str(path.relative_to(ROOT)),
        "images": {
            "api": run(["docker", "image", "inspect", "--format", "{{.Id}}", api_image])
            .decode()
            .strip(),
            "web": run(["docker", "image", "inspect", "--format", "{{.Id}}", web_image])
            .decode()
            .strip(),
            "database": database_image,
        },
        "steps": {},
    }

    def step(name: str) -> None:
        nonlocal stage
        stage = name
        print(json.dumps({"stage": name}), flush=True)

    with TemporaryDirectory(prefix="recovery-", dir=ROOT / "tmp") as temp:
        directory = Path(temp)
        (directory / "state").mkdir(mode=0o777)
        (directory / "state").chmod(0o777)  # Outer temporary directory is private (0700).
        photo_volume = network + "-photos"
        app_secret = secrets.token_hex(32)
        admin_secret = secrets.token_hex(32)
        for name, secret in [("app_password", app_secret), ("postgres_password", admin_secret)]:
            target = directory / name
            target.write_text(secret)
            target.chmod(0o444)  # Readable inside non-root container; outer directory is 0700.
        db, api, web, worker = [network + "-" + suffix for suffix in ("db", "api", "web", "worker")]

        def sql(query: str) -> str:
            return (
                run(
                    [
                        "docker",
                        "exec",
                        "-i",
                        db,
                        "psql",
                        "-U",
                        "naryadai",
                        "-d",
                        "naryadai",
                        "-v",
                        "ON_ERROR_STOP=1",
                        "-At",
                    ],
                    data=query.encode(),
                )
                .decode()
                .strip()
            )

        def probe(mode: str, extra: dict | None = None) -> dict:
            payload = {"base_url": "http://" + web + ":8080", **(extra or {})}
            return json.loads(
                run(
                    ["docker", "exec", "-i", api, "python", "/opt/operations_probe.py", mode],
                    data=json.dumps(payload).encode(),
                    timeout=120,
                )
            )

        def app_args(name: str) -> list[str]:
            return [
                "docker",
                "run",
                "-d",
                "--name",
                name,
                "--network",
                network,
                "--read-only",
                "--tmpfs",
                "/tmp",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "-e",
                "NARYADAI_ENVIRONMENT=production",
                "-e",
                "NARYADAI_DB_HOST=" + db,
                "-e",
                'NARYADAI_ALLOWED_HOSTS=["localhost","127.0.0.1","' + web + '"]',
                "-e",
                "NARYADAI_PHOTO_ROOT=/app/var/photos",
                "-e",
                "NARYADAI_AI_VISION_ENABLED=false",
                "--mount",
                f"type=bind,src={directory / 'app_password'},"
                "dst=/run/secrets/app_password,readonly",
                "--mount",
                f"type=volume,src={photo_volume},dst=/app/var/photos",
            ]

        try:
            step("isolated_database_restore")
            run(["docker", "network", "create", "--internal", network])
            names.append(db)
            run(
                [
                    "docker",
                    "run",
                    "-d",
                    "--name",
                    db,
                    "--network",
                    network,
                    "-e",
                    "POSTGRES_USER=naryadai",
                    "-e",
                    "POSTGRES_DB=naryadai",
                    "-e",
                    "POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password",
                    "--mount",
                    f"type=bind,src={directory / 'postgres_password'},"
                    "dst=/run/secrets/postgres_password,readonly",
                    database_image,
                ]
            )
            for _ in range(60):
                check = subprocess.run(
                    ["docker", "exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "naryadai"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                if check.returncode == 0:
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError("isolated_database_not_ready")
            run(
                [
                    "docker",
                    "exec",
                    "-i",
                    db,
                    "pg_restore",
                    "-U",
                    "naryadai",
                    "-d",
                    "naryadai",
                    "--no-owner",
                    "--no-privileges",
                    "--exit-on-error",
                ],
                data=(path / "database.dump").read_bytes(),
            )
            sql(
                "CREATE ROLE naryadai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '"
                + app_secret
                + "';\n"
                "GRANT USAGE ON SCHEMA public TO naryadai_app;\n"
                "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES "
                "IN SCHEMA public TO naryadai_app;\n"
                "GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO naryadai_app;"
            )
            rows = json.loads(
                sql(
                    "SELECT coalesce(json_agg(p),'[]'::json) FROM "
                    "(SELECT id,work_order_id,storage_key,sha256,size_bytes FROM photos) p;"
                )
            )
            result["steps"]["photo_integrity"] = verify_photo_archive(path / "photos.tar.gz", rows)
            run(["docker", "volume", "create", photo_volume])
            # Archive paths were validated above. Copy only regular photo files,
            # never archive permissions, links or ownership, into a private volume.
            restore_code = (
                "import os, pathlib, tarfile; root=pathlib.Path('/restore'); "
                "archive=tarfile.open('/backup/photos.tar.gz', 'r:gz'); "
                "[(root.joinpath(pathlib.PurePosixPath(m.name).name).write_bytes("
                "archive.extractfile(m).read())) for m in archive if m.isfile()]; "
                "[(os.chown(p,10001,10001),os.chmod(p,0o600)) for p in root.iterdir()]; "
                "os.chown(root,10001,10001); os.chmod(root,0o700)"
            )
            run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--network",
                    "none",
                    "--user",
                    "0",
                    "--entrypoint",
                    "python",
                    "--mount",
                    f"type=volume,src={photo_volume},dst=/restore",
                    "--mount",
                    f"type=bind,src={path / 'photos.tar.gz'},dst=/backup/photos.tar.gz,readonly",
                    api_image,
                    "-c",
                    restore_code,
                ]
            )
            counts = sql(COUNTS).splitlines()
            if counts != manifest["counts"]:
                raise RuntimeError("restored_counts_differ")
            result["restored_counts"] = counts
            step("restored_application_start")
            names.append(api)
            run(
                [
                    *app_args(api),
                    "--mount",
                    f"type=bind,src={ROOT / 'scripts/operations_probe.py'},"
                    "dst=/opt/operations_probe.py,readonly",
                    "--mount",
                    f"type=bind,src={directory / 'state'},dst=/probe-state",
                    api_image,
                ]
            )
            caddy = directory / "Caddyfile"
            caddy.write_text(
                ":8080 {\n root * /srv\n @api path /api/*\n handle @api {\n reverse_proxy "
                + api
                + ":8000\n }\n handle {\n try_files {path} /index.html\n file_server\n }\n}\n"
            )
            names.append(web)
            run(
                [
                    "docker",
                    "run",
                    "-d",
                    "--name",
                    web,
                    "--network",
                    network,
                    "--mount",
                    f"type=bind,src={caddy},dst=/etc/caddy/Caddyfile,readonly",
                    web_image,
                ]
            )
            result["steps"]["ready"] = probe("ready")
            credential_file = ROOT / "var/docker/industrial-credentials.txt"
            match = re.search(r"^Password: (.+)$", credential_file.read_text(), re.M)
            if not match:
                raise RuntimeError("local_recovery_credential_missing")
            result["steps"]["baseline"] = probe(
                "baseline",
                {"credentials": {"login": "master.sadykov", "secret": match[1]}, "photos": rows},
            )
            step("abrupt_api_restart_and_retry")
            run(["docker", "kill", "--signal", "KILL", api])
            run(["docker", "start", api])
            probe("ready")
            result["steps"]["api_restart"] = probe("replay")
            step("database_restart_and_reconnect")
            run(["docker", "restart", db])
            probe("ready")
            result["steps"]["database_restart"] = probe("replay")
            step("worker_restart_and_durable_outbox")
            order_id = probe("outbox")["order_id"]
            names.append(worker)
            run([*app_args(worker), api_image, "python", "-m", "naryadai.worker"])
            run(["docker", "kill", "--signal", "KILL", worker])
            run(["docker", "start", worker])
            for _ in range(40):
                pending = sql(
                    f"SELECT count(*) FROM outbox_events WHERE work_order_id='{order_id}' "
                    "AND processed_at IS NULL;"
                )
                if pending == "0":
                    break
                time.sleep(0.5)
            else:
                raise RuntimeError("outbox_not_recovered")
            result["steps"]["worker_restart"] = {
                "durable_outbox_drained": True,
                "external_delivery_disabled": True,
            }
            step("bounded_authenticated_load")
            result["steps"]["load"] = probe("load")
            if result["steps"]["load"]["status"] != "PASS":
                raise RuntimeError("load_budget_exceeded")
            result["status"] = "PASS"
        except Exception as error:
            result["failed_stage"] = stage
            result["error_type"] = type(error).__name__
            result["error_code"] = (
                str(error)
                if str(error)
                in {
                    "isolated_command_failed",
                    "restored_counts_differ",
                    "outbox_not_recovered",
                    "load_budget_exceeded",
                    "no_photo_access_verified",
                }
                else "recovery_probe_failed"
            )
            markers = [
                "PermissionError",
                "Permission denied",
                "connection refused",
                "could not translate host name",
                "address already in use",
            ]
            result["diagnostic_markers"] = {}
            for name in names:
                logged = subprocess.run(
                    ["docker", "logs", "--tail", "30", name],
                    capture_output=True,
                    check=False,
                    timeout=10,
                )
                content = (logged.stdout + logged.stderr).decode(errors="replace")
                result["diagnostic_markers"][name.rsplit("-", 1)[-1]] = [
                    marker for marker in markers if marker.lower() in content.lower()
                ]
        finally:
            result["disposable_resources_removed"] = cleanup(names, network)
            if not result["disposable_resources_removed"]:
                result["status"] = "FAIL"
                result["cleanup_failed"] = True
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--backup", type=Path, required=True)
    parser.add_argument("--api-image", default="technaryad-api:local")
    parser.add_argument("--web-image", default="technaryad-web:local")
    parser.add_argument("--database-image", default="")
    args = parser.parse_args()
    if not args.execute:
        parser.error("--execute is required to create disposable Docker resources")
    os.umask(0o077)
    output = (
        ROOT
        / "tmp/review"
        / ("operations-" + datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + ".json")
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    result = verify(args.backup, args.api_image, args.web_image, args.database_image)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"artifact": str(output.relative_to(ROOT)), **result}, ensure_ascii=False))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
