"""Expose a local PWA through an isolated, temporary Cloudflare Quick Tunnel.

Run with uv from Ubuntu/WSL. Uses existing data/settings; never seeds or migrates.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
QUICK_HOST = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com")
QUICK_URL = re.compile(r"https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=\s|$)")


class PhoneError(RuntimeError):
    """An actionable local startup failure, without credential values."""


def tunnel_environment(origin: str, api_port: int) -> dict[str, str]:
    parsed = urlsplit(origin)
    if (
        parsed.scheme != "https"
        or not QUICK_HOST.fullmatch(parsed.netloc)
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise PhoneError("Expected one exact https://name.trycloudflare.com origin")
    env = os.environ.copy()
    # Keep backend Host/Origin checks independent of Vite. No forwarded-header trust.
    env.update(
        NARYADAI_PUBLIC_HOST=parsed.netloc,
        NARYADAI_API_TARGET=f"http://127.0.0.1:{api_port}",
        NARYADAI_ALLOWED_HOSTS=json.dumps(["localhost", "127.0.0.1", "[::1]", parsed.netloc]),
        NARYADAI_CORS_ORIGINS=json.dumps([origin]),
        NARYADAI_ENVIRONMENT="production",  # Disable public Swagger and debug responses.
        NARYADAI_LOG_LEVEL="INFO",
    )
    env.pop("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS", None)
    return env


def require_free_ports(*ports: int) -> None:
    if len(set(ports)) != len(ports) or any(not 1024 <= port <= 65535 for port in ports):
        raise PhoneError("Use distinct ports between 1024 and 65535")
    for port in ports:
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                raise PhoneError(
                    f"Port {port} is busy; stop the earlier phone run or choose ports"
                ) from None


class Processes:
    """Own only the process groups created in this invocation."""

    def __init__(self, logs: Path) -> None:
        self.logs = logs
        self.children: list[tuple[str, subprocess.Popen[bytes]]] = []

    def start(self, name: str, command: list[str], env: dict[str, str]) -> subprocess.Popen[bytes]:
        path = self.logs / f"{name}.log"
        with path.open("xb") as log:
            path.chmod(0o600)
            process = subprocess.Popen(
                command,
                cwd=ROOT,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        self.children.append((name, process))
        return process

    def check(self) -> None:
        for name, process in self.children:
            if process.poll() is not None:
                raise PhoneError(f"{name} stopped; inspect {self.logs / (name + '.log')}")

    def stop(self) -> None:
        # Reverse startup order; process groups also cover npm's Vite child.
        for _, process in reversed(self.children):
            if process.poll() is None:
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGTERM)
        deadline = time.monotonic() + 8
        for _, process in reversed(self.children):
            try:
                process.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                if process.poll() is None:
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def wait_http(url: str, processes: Processes, *, host: str | None = None) -> None:
    request = Request(url, headers={"Host": host} if host else {})
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        processes.check()
        try:
            with urlopen(request, timeout=2) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(0.25)
    raise PhoneError(f"Readiness failed for {url}; check logs, database and migrations")


def wait_tunnel(processes: Processes) -> str:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        processes.check()
        log = (processes.logs / "cloudflared.log").read_text(errors="replace")
        match = QUICK_URL.search(log)
        if match and "Registered tunnel connection" in log:
            return match.group()
        time.sleep(0.25)
    raise PhoneError("Cloudflare did not connect in 90 seconds; inspect cloudflared.log")


def run(api_port: int, web_port: int, *, worker: bool) -> None:
    if sys.platform != "linux":
        raise PhoneError("Run this command inside Ubuntu/WSL")
    cloudflared = shutil.which("cloudflared")
    if cloudflared is None:
        raise PhoneError("cloudflared is missing; see docs/phone-tunnel.md")
    require_free_ports(api_port, web_port)
    logs = ROOT / "var" / "phone-tunnel" / uuid4().hex
    logs.mkdir(parents=True, mode=0o700)
    processes = Processes(logs)
    print(f"Logs: {logs}", flush=True)
    try:
        print("Building the PWA...", flush=True)
        build = processes.start(
            "build", ["bash", "scripts/frontend.sh", "run", "build"], os.environ.copy()
        )
        try:
            code = build.wait(timeout=180)
        except subprocess.TimeoutExpired:
            raise PhoneError("Build timed out; inspect build.log") from None
        if code:
            raise PhoneError("Build failed; inspect build.log (run frontend.sh ci if needed)")
        processes.children.remove(("build", build))
        print("Connecting Cloudflare (up to 90 seconds)...", flush=True)
        processes.start(
            "cloudflared",
            [
                cloudflared,
                "tunnel",
                "--no-autoupdate",
                "--url",
                f"http://127.0.0.1:{web_port}",
            ],
            os.environ.copy(),
        )
        origin = wait_tunnel(processes)
        env = tunnel_environment(origin, api_port)
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
            "preview",
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
        host = urlsplit(origin).netloc
        for path in ("/", "/sw.js", "/manifest.webmanifest", "/api/v1/health/ready"):
            wait_http(f"http://127.0.0.1:{web_port}{path}", processes, host=host)
        (logs / "url.txt").write_text(origin + "\n")
        print(
            f"\nOpen on your phone: {origin}\nKeep this terminal open. Stop: Ctrl+C.\n", flush=True
        )
        while True:
            processes.check()
            time.sleep(1)
    finally:
        processes.stop()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-port", type=int, default=8001)
    parser.add_argument("--web-port", type=int, default=5174)
    parser.add_argument("--no-worker", action="store_true", help="Use your already running worker")
    args = parser.parse_args()

    def interrupt(_signum: int, _frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        run(args.api_port, args.web_port, worker=not args.no_worker)
    except KeyboardInterrupt:
        print("\nPhone tunnel stopped. Existing local services and database were preserved.")
        return 0
    except (PhoneError, OSError) as exc:
        print(f"Phone startup failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
