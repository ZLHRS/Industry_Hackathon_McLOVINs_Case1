"""Run the complete local demo: existing database, API, worker and production PWA.

Usage: uv run python scripts/demo.py [--seed] [--skip-build]
No public tunnel is opened. Ctrl+C stops only processes started by this command.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

from phone_tunnel import PhoneError, Processes, require_free_ports, wait_http

ROOT = Path(__file__).resolve().parents[1]


def run(*, api_port: int, web_port: int, seed: bool, skip_build: bool, worker: bool) -> None:
    if sys.platform not in {"linux", "darwin"}:
        raise PhoneError("Run this command on Linux/WSL or macOS")
    require_free_ports(api_port, web_port)
    if not (ROOT / "frontend/node_modules").is_dir():
        raise PhoneError("Install frontend dependencies first: bash scripts/frontend.sh ci")
    if skip_build and not (ROOT / "frontend/dist/sw.js").is_file():
        raise PhoneError("No production build found. Run without --skip-build first.")
    env = os.environ.copy()
    env["NARYADAI_API_TARGET"] = f"http://127.0.0.1:{api_port}"
    logs = ROOT / "var/demo-runs" / uuid4().hex
    logs.mkdir(parents=True, mode=0o700)
    processes = Processes(logs)
    print(f"Local logs: {logs}", flush=True)

    def step(name: str, command: list[str]) -> None:
        print(name + "…", flush=True)
        process = processes.start(name, command, env)
        try:
            code = process.wait(timeout=180)
        except subprocess.TimeoutExpired:
            raise PhoneError(f"{name} timed out; inspect {logs / (name + '.log')}") from None
        if code:
            raise PhoneError(f"{name} failed; inspect {logs / (name + '.log')}")
        processes.children.remove((name, process))

    try:
        step("database", [sys.executable, "scripts/dev_database.py", "start"])
        step("migrations", [sys.executable, "-m", "alembic", "upgrade", "head"])
        if seed:
            step("seed", [sys.executable, "-m", "seeds.industrial", "apply"])
            print("Demo accounts: var/industrial-credentials.txt (private local file)", flush=True)
        if not skip_build:
            step("build", ["bash", "scripts/frontend.sh", "run", "build"])
        processes.start(
            "api",
            [
                sys.executable,
                "-m",
                "uvicorn",
                "naryadai.app:create_app",
                "--factory",
                "--host",
                "127.0.0.1",
                "--port",
                str(api_port),
                "--no-access-log",
                "--no-proxy-headers",
                "--ws",
                "websockets-sansio",
                "--ws-max-size",
                "4096",
            ],
            env,
        )
        wait_http(f"http://127.0.0.1:{api_port}/api/v1/health/ready", processes)
        if worker:
            processes.start("worker", [sys.executable, "-m", "naryadai.worker"], env)
        processes.start(
            "web",
            [
                "bash",
                "scripts/frontend.sh",
                "run",
                "preview",
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                str(web_port),
                "--strictPort",
            ],
            env,
        )
        for path in ("/", "/sw.js", "/manifest.webmanifest", "/api/v1/health/ready"):
            wait_http(f"http://127.0.0.1:{web_port}{path}", processes)
        print(f"\nDemo: http://127.0.0.1:{web_port}\nStop: Ctrl+C\n", flush=True)
        while True:
            processes.check()
            time.sleep(1)
    finally:
        processes.stop()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-port", type=int, default=8000)
    parser.add_argument("--web-port", type=int, default=5173)
    parser.add_argument(
        "--seed", action="store_true", help="Apply fictional data to an empty database"
    )
    parser.add_argument("--skip-build", action="store_true", help="Reuse the existing PWA build")
    parser.add_argument("--no-worker", action="store_true", help="Use your already running worker")
    args = parser.parse_args()

    def interrupt(_signum: int, _frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        run(
            api_port=args.api_port,
            web_port=args.web_port,
            seed=args.seed,
            skip_build=args.skip_build,
            worker=not args.no_worker,
        )
    except KeyboardInterrupt:
        print("\nDemo stopped. Database and files preserved.")
        return 0
    except (PhoneError, OSError) as error:
        print(f"Demo startup failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
