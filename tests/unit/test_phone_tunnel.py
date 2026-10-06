import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import Mock

import pytest

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "phone_tunnel.py"
_SPEC = importlib.util.spec_from_file_location("phone_tunnel", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


@pytest.mark.parametrize(
    "origin",
    [
        "http://phone.trycloudflare.com",
        "https://.trycloudflare.com",
        "https://phone.trycloudflare.com.evil.test",
        "https://user@phone.trycloudflare.com",
        "https://phone.trycloudflare.com:443",
        "https://phone.trycloudflare.com/path",
        "https://phone.trycloudflare.com?x=1",
        "https://phone.trycloudflare.com#x",
        "*",
    ],
)
def test_rejects_unsafe_public_origins(origin: str) -> None:
    with pytest.raises(_MODULE.PhoneError):
        _MODULE.tunnel_environment(origin, 8001)


def test_child_settings_are_exact_and_do_not_change_parent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NARYADAI_CORS_ORIGINS", '["https://old.example"]')
    monkeypatch.setenv("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS", "unrelated.example")
    env = _MODULE.tunnel_environment("https://repair-phone.trycloudflare.com", 8001)
    assert json.loads(env["NARYADAI_ALLOWED_HOSTS"]) == [
        "localhost",
        "127.0.0.1",
        "[::1]",
        "repair-phone.trycloudflare.com",
    ]
    assert json.loads(env["NARYADAI_CORS_ORIGINS"]) == ["https://repair-phone.trycloudflare.com"]
    assert env["NARYADAI_ENVIRONMENT"] == "production"
    assert "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS" not in env
    assert os.environ["NARYADAI_CORS_ORIGINS"] == '["https://old.example"]'


def test_busy_port_fails_without_stopping_owner() -> None:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        port = server.getsockname()[1]
        with pytest.raises(_MODULE.PhoneError, match="busy"):
            _MODULE.require_free_ports(port)
        server.listen()
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass


@pytest.mark.parametrize("ports", [(8001, 8001), (0, 5174), (8001, 65536)])
def test_invalid_ports_rejected(ports: tuple[int, int]) -> None:
    with pytest.raises(_MODULE.PhoneError):
        _MODULE.require_free_ports(*ports)


@pytest.mark.skipif(sys.platform != "linux", reason="Ubuntu/WSL process groups")
def test_cleanup_terminates_owned_descendants_but_preserves_unrelated_process(
    tmp_path: Path,
) -> None:
    processes = _MODULE.Processes(tmp_path)
    unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        marker = tmp_path / "descendant-port"
        descendant_code = (
            "import socket, time; from pathlib import Path; s=socket.socket(); "
            "s.bind(('127.0.0.1', 0)); s.listen(); "
            f"Path({str(marker)!r}).write_text(str(s.getsockname()[1])); time.sleep(30)"
        )
        parent_code = (
            "import subprocess, sys, time; "
            f"subprocess.Popen([sys.executable, '-c', {descendant_code!r}]); time.sleep(30)"
        )
        child = processes.start("api", [sys.executable, "-c", parent_code], os.environ.copy())
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert marker.exists(), "descendant failed to start"
        port = int(marker.read_text())
        processes.stop()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))  # Descendant listener was also terminated.
        assert child.poll() is not None
        assert unrelated.poll() is None
        assert (tmp_path / "api.log").stat().st_mode & 0o777 == 0o600
    finally:
        processes.stop()
        unrelated.terminate()
        unrelated.wait(timeout=5)


def test_graceful_exit_does_not_send_signal_to_reaped_group(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    process = Mock(pid=12345)
    process.poll.side_effect = [None, 0]
    process.wait.return_value = 0
    kill = Mock()
    monkeypatch.setattr(_MODULE.os, "killpg", kill)
    processes = _MODULE.Processes(tmp_path)
    processes.children.append(("preview", process))
    processes.stop()
    kill.assert_called_once_with(12345, signal.SIGTERM)


def test_timeout_escalates_only_a_still_running_group(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    process = Mock(pid=12345)
    process.poll.return_value = None
    process.wait.side_effect = [subprocess.TimeoutExpired("preview", 8), 0]
    kill = Mock()
    monkeypatch.setattr(_MODULE.os, "killpg", kill)
    processes = _MODULE.Processes(tmp_path)
    processes.children.append(("preview", process))
    processes.stop()
    assert [call.args for call in kill.call_args_list] == [
        (12345, signal.SIGTERM),
        (12345, signal.SIGKILL),
    ]
