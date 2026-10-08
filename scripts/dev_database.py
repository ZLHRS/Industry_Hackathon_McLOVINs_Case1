"""Manage only this project's development PostgreSQL cluster on Linux or macOS."""

import argparse
import os
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

import psycopg
from sqlalchemy.engine import make_url

from naryadai.config import Settings

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "var" / "postgres"
BIN = BASE / "runtime" / "usr" / "lib" / "postgresql" / "16" / "bin"
SHARE = BASE / "runtime" / "usr" / "share" / "postgresql" / "16"
DATA = BASE / "data"
PORT = 55432


def postgres_runtime(*, required_major: str | None = None) -> tuple[Path, Path | None]:
    """Prefer the workspace runtime; never connect to an installed system cluster."""
    configured = os.environ.get("NARYADAI_PG_BIN")
    candidates = [Path(configured)] if configured else [BIN]
    if not configured:
        if found := shutil.which("pg_ctl"):
            candidates.append(Path(found).resolve().parent)
        if sys.platform == "darwin":
            candidates.extend(
                [
                    Path("/opt/homebrew/opt/postgresql@16/bin"),
                    Path("/usr/local/opt/postgresql@16/bin"),
                    Path("/Library/PostgreSQL/16/bin"),
                    Path("/opt/homebrew/opt/postgresql@17/bin"),
                    Path("/usr/local/opt/postgresql@17/bin"),
                    Path("/Library/PostgreSQL/17/bin"),
                ]
            )
    for candidate in candidates:
        if all((candidate / executable).is_file() for executable in ("pg_ctl", "initdb")):
            if required_major is None:
                return candidate, SHARE if candidate == BIN else None
            installed = subprocess.check_output(
                [str(candidate / "postgres"), "--version"], text=True
            )
            major = re.search(r"\b(\d+)\.\d+", installed)
            if major is not None and major.group(1) == required_major:
                return candidate, SHARE if candidate == BIN else None
    if required_major is not None:
        raise SystemExit(
            "No PostgreSQL binary matching the existing cluster major was found; "
            "set NARYADAI_PG_BIN to its bin directory."
        )
    raise SystemExit(
        "PostgreSQL binaries not found. On Ubuntu run bootstrap; on macOS install "
        "PostgreSQL 16/17 or set NARYADAI_PG_BIN to its bin directory."
    )


def run(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(args, check=True, cwd=cwd)


def private_file(path: Path, content: str) -> None:
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        stream.write(content)


def verify_application_connection(app_url: str) -> None:
    """Do not report readiness for a different or stale application configuration."""
    message = (
        "Application database configuration does not match this workspace cluster. "
        "Check NARYADAI_DATABASE_URL in the environment and .env against "
        "var/postgres/app-password; existing configuration was not overwritten."
    )
    try:
        configured = Settings(_env_file=ROOT / ".env").database_url
        if configured is None or make_url(configured.get_secret_value()) != make_url(app_url):
            raise SystemExit(message)
    except ValueError:
        raise SystemExit(message) from None
    try:
        with psycopg.connect(
            make_url(app_url).set(drivername="postgresql").render_as_string(hide_password=False),
            connect_timeout=3,
        ) as connection:
            connection.execute("SELECT 1")
    except psycopg.Error:
        raise SystemExit(
            "Application database login failed; check the workspace role and private credentials."
        ) from None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["bootstrap", "start", "stop", "status"])
    args = parser.parse_args()
    BASE.mkdir(parents=True, exist_ok=True)
    if args.action == "bootstrap":
        if sys.platform != "linux":
            binary, _ = postgres_runtime()
            run(str(binary / "postgres"), "--version")
            print("Using installed binaries with a separate workspace cluster.")
            return
        packages = BASE / "packages"
        packages.mkdir(exist_ok=True)
        run("apt-get", "download", "postgresql-16", cwd=packages)
        candidates = sorted(packages.glob("postgresql-16_*.deb"))
        if len(candidates) != 1:
            raise SystemExit("Expected one PostgreSQL package; inspect var/postgres/packages")
        run("dpkg-deb", "-x", str(candidates[0]), str(BASE / "runtime"))
        run(str(BIN / "postgres"), "--version")
        return
    cluster_version = DATA / "PG_VERSION"
    binary, share = postgres_runtime(
        required_major=cluster_version.read_text().strip() if cluster_version.is_file() else None
    )
    if (DATA / "PG_VERSION").is_file():
        installed = subprocess.check_output([str(binary / "postgres"), "--version"], text=True)
        major = re.search(r"\b(\d+)\.\d+", installed)
        if major is None or major.group(1) != (DATA / "PG_VERSION").read_text().strip():
            raise SystemExit(
                "Cluster major version differs from PostgreSQL binaries; set NARYADAI_PG_BIN."
            )
    if args.action == "status":
        result = subprocess.run([str(binary / "pg_ctl"), "-D", str(DATA), "status"], check=False)
        raise SystemExit(result.returncode)
    if args.action == "stop":
        status = subprocess.run(
            [str(binary / "pg_ctl"), "-D", str(DATA), "status"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if status.returncode == 3:
            return
        run(str(binary / "pg_ctl"), "-D", str(DATA), "-m", "fast", "-w", "stop")
        return
    password_path = BASE / "password"
    if not password_path.exists():
        if DATA.exists():
            raise SystemExit("Existing cluster has no project password file; refusing to reset")
        private_file(password_path, secrets.token_urlsafe(32))
    password = password_path.read_text().strip()
    if not (DATA / "PG_VERSION").exists():
        run(
            str(binary / "initdb"),
            "-D",
            str(DATA),
            *(["-L", str(share)] if share else []),
            "-U",
            "naryadai",
            "--encoding=UTF8",
            "--locale=" + ("en_US.UTF-8" if sys.platform == "darwin" else "C.UTF-8"),
            "--auth=scram-sha-256",
            "--pwfile",
            str(password_path),
        )
        with (DATA / "postgresql.conf").open("a") as stream:
            stream.write("\nlisten_addresses='127.0.0.1'\nport=55432\n")
            stream.write("unix_socket_directories=''\njit=off\n")
            stream.write("statement_timeout='15s'\nidle_in_transaction_session_timeout='30s'\n")
    status = subprocess.run(
        [str(binary / "pg_ctl"), "-D", str(DATA), "status"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if status.returncode != 0:
        run(str(binary / "pg_ctl"), "-D", str(DATA), "-l", str(BASE / "server.log"), "-w", "start")
    app_password_path = BASE / "app-password"
    if not app_password_path.exists():
        private_file(app_password_path, secrets.token_urlsafe(32))
    app_password = app_password_path.read_text().strip()
    with psycopg.connect(
        host="127.0.0.1",
        port=PORT,
        user="naryadai",
        password=password,
        dbname="postgres",
        autocommit=True,
    ) as connection:
        if not connection.execute(
            "SELECT 1 FROM pg_roles WHERE rolname=%s", ("naryadai_app",)
        ).fetchone():
            connection.execute(
                psycopg.sql.SQL(
                    "CREATE ROLE naryadai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD {}"
                ).format(psycopg.sql.Literal(app_password))
            )
        for name in ("naryadai", "naryadai_test"):
            exists = connection.execute(
                "SELECT 1 FROM pg_database WHERE datname=%s", (name,)
            ).fetchone()
            if not exists:
                connection.execute(
                    psycopg.sql.SQL("CREATE DATABASE {}").format(psycopg.sql.Identifier(name))
                )
        connection.execute("ALTER DATABASE naryadai OWNER TO naryadai_app")
    prefix = f"postgresql+psycopg://naryadai:{password}@127.0.0.1:{PORT}/"
    app_url = f"postgresql+psycopg://naryadai_app:{app_password}@127.0.0.1:{PORT}/naryadai"
    test_url = BASE / "test-url"
    if not test_url.exists():
        private_file(test_url, prefix + "naryadai_test")
    env_file = ROOT / ".env"
    if not env_file.exists():
        private_file(env_file, "NARYADAI_DATABASE_URL=" + app_url + "\n")
    verify_application_connection(app_url)
    print("Development PostgreSQL ready on 127.0.0.1:55432")
    print(
        "Database password kept in ignored var/postgres/password; existing .env never overwritten"
    )


if __name__ == "__main__":
    try:
        main()
    except (subprocess.CalledProcessError, psycopg.Error):
        print("Database setup failed; inspect var/postgres/server.log", file=sys.stderr)
        raise SystemExit(1) from None
