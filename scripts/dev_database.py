"""Manage only this project's development PostgreSQL cluster (Ubuntu/WSL)."""

import argparse
import os
import secrets
import subprocess
import sys
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "var" / "postgres"
BIN = BASE / "runtime" / "usr" / "lib" / "postgresql" / "16" / "bin"
SHARE = BASE / "runtime" / "usr" / "share" / "postgresql" / "16"
DATA = BASE / "data"
PORT = 55432


def run(*args: str, **kwargs: object) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=True, **kwargs)


def private_file(path: Path, content: str) -> None:
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        stream.write(content)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["bootstrap", "start", "stop", "status"])
    args = parser.parse_args()
    BASE.mkdir(parents=True, exist_ok=True)
    if args.action == "bootstrap":
        packages = BASE / "packages"
        packages.mkdir(exist_ok=True)
        run("apt-get", "download", "postgresql-16", cwd=packages)
        candidates = sorted(packages.glob("postgresql-16_*.deb"))
        if len(candidates) != 1:
            raise SystemExit("Expected one PostgreSQL package; inspect var/postgres/packages")
        run("dpkg-deb", "-x", str(candidates[0]), str(BASE / "runtime"))
        run(str(BIN / "postgres"), "--version")
        return
    if not (BIN / "pg_ctl").is_file():
        raise SystemExit(
            "Run bootstrap first on Ubuntu with apt-get and PostgreSQL client installed"
        )
    if args.action == "status":
        result = subprocess.run([str(BIN / "pg_ctl"), "-D", str(DATA), "status"], check=False)
        raise SystemExit(result.returncode)
    if args.action == "stop":
        run(str(BIN / "pg_ctl"), "-D", str(DATA), "-m", "fast", "-w", "stop")
        return
    password_path = BASE / "password"
    if not password_path.exists():
        if DATA.exists():
            raise SystemExit("Existing cluster has no project password file; refusing to reset")
        private_file(password_path, secrets.token_urlsafe(32))
    password = password_path.read_text().strip()
    if not (DATA / "PG_VERSION").exists():
        run(
            str(BIN / "initdb"),
            "-D",
            str(DATA),
            "-L",
            str(SHARE),
            "-U",
            "naryadai",
            "--encoding=UTF8",
            "--locale=C.UTF-8",
            "--auth=scram-sha-256",
            "--pwfile",
            str(password_path),
        )
        with (DATA / "postgresql.conf").open("a") as stream:
            stream.write("\nlisten_addresses='127.0.0.1'\nport=55432\n")
            stream.write("unix_socket_directories=''\njit=off\n")
            stream.write("statement_timeout='15s'\nidle_in_transaction_session_timeout='30s'\n")
    status = subprocess.run(
        [str(BIN / "pg_ctl"), "-D", str(DATA), "status"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if status.returncode != 0:
        run(str(BIN / "pg_ctl"), "-D", str(DATA), "-l", str(BASE / "server.log"), "-w", "start")
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
