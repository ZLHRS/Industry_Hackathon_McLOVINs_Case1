"""Exercise maintenance sequencing without accessing Docker or the live database."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def run_wrapper(tmp_path, *, apply=False, fail="", running="api\nworker\n"):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    script = scripts / "refresh_orders_docker.sh"
    shutil.copyfile(ROOT / "scripts/refresh_orders_docker.sh", script)
    binary = tmp_path / "bin"
    binary.mkdir()
    docker = binary / "docker"
    docker.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "args = sys.argv[1:]\n"
        "with open(os.environ['DOCKER_LOG'], 'a') as log:\n"
        "    log.write(json.dumps(args) + '\\n')\n"
        "if os.environ['FAIL_STEP'] and os.environ['FAIL_STEP'] in args:\n"
        "    sys.exit(17)\n"
        "if 'ps' in args:\n"
        "    print(os.environ['RUNNING_SERVICES'], end='')\n"
    )
    docker.chmod(0o700)
    log = tmp_path / "docker.jsonl"
    result = subprocess.run(
        ["bash", str(script), "--anchor", "2026-10-15T00:00:00+05:00"]
        + (["--apply"] if apply else []),
        env={
            **os.environ,
            "PATH": str(binary) + os.pathsep + os.environ["PATH"],
            "DOCKER_LOG": str(log),
            "FAIL_STEP": fail,
            "RUNNING_SERVICES": running,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    return result, [json.loads(line) for line in log.read_text().splitlines()]


def test_preview_never_stops_services_or_replaces_orders(tmp_path):
    result, calls = run_wrapper(tmp_path)
    assert result.returncode == 0
    assert any("preview-orders" in call for call in calls)
    assert not any({"stop", "start", "replace-orders", "cp"} & set(call) for call in calls)


def test_apply_stops_and_restarts_only_previously_running_services(tmp_path):
    result, calls = run_wrapper(tmp_path, apply=True, running="postgres\napi\nweb\n")
    assert result.returncode == 0
    steps = [
        next(step for step in ("build", "up", "run", "ps", "stop", "cp", "rm", "start")
             if step in call)
        for call in calls
    ]
    assert steps == ["build", "up", "run", "ps", "stop", "run", "cp", "rm", "start"]
    assert next(call for call in calls if "stop" in call)[-2:] == ["stop", "api"]
    assert calls[-1][-2:] == ["start", "api"]
    replace = next(call for call in calls if "replace-orders" in call)
    assert replace[-2:] == ["--confirm", "REPLACE-ORDERS"]
    assert (tmp_path / "var/docker/order-backups").stat().st_mode & 0o777 == 0o700


@pytest.mark.parametrize("fail", ["replace-orders", "cp"])
def test_failure_restarts_services_and_preserves_nonzero_exit(tmp_path, fail):
    result, calls = run_wrapper(tmp_path, apply=True, fail=fail)
    assert result.returncode == 17
    assert calls[-1][-3:] == ["start", "api", "worker"]
    assert calls[-2][0:2] == ["rm", "-f"]
    if fail == "replace-orders":
        assert not any(call[0] == "cp" for call in calls)


@pytest.mark.parametrize("fail", ["preview-orders", "ps"])
def test_preflight_failure_does_not_stop_services(tmp_path, fail):
    result, calls = run_wrapper(tmp_path, apply=True, fail=fail)
    assert result.returncode == 17
    assert not any({"stop", "replace-orders"} & set(call) for call in calls)


def test_apply_keeps_previously_stopped_services_stopped(tmp_path):
    result, calls = run_wrapper(tmp_path, apply=True, running="postgres\n")
    assert result.returncode == 0
    assert not any({"stop", "start"} & set(call) for call in calls)
