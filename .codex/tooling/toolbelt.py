#!/usr/bin/env python3
"""Small, dependency-free project diagnostics.

The command line uses only the standard library and optional explicit project
commands from ``[tool.codex_toolbelt]``.
"""
from __future__ import annotations

import csv
import importlib.util
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Sequence

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 should receive a clear error below.
    tomllib = None  # type: ignore[assignment]

OK, FAILED, MISSING = 0, 1, 2
TIMEOUT_SECONDS = 120
HTTP_TIMEOUT_SECONDS = 15
MAX_DATASET_BYTES = 32 * 1024 * 1024
MAX_DATASET_ROWS = 10_000


class ConfigurationError(ValueError):
    """A present toolbelt configuration is invalid and must not be ignored."""


def note(message: str) -> None:
    print(message)


def result_code(results: Sequence[int]) -> int:
    """Failures win over unavailable checks, which win over successful ones."""
    if any(code == FAILED for code in results):
        return FAILED
    if any(code == MISSING for code in results) or not results:
        return MISSING
    return OK


def executable(name: str) -> str | None:
    return shutil.which(name)


def run(
    argv: Sequence[str], *, cwd: Path | None = None, timeout: int = TIMEOUT_SECONDS,
    sensitive: bool = False, quiet: bool = False,
) -> int:
    """Run an argv safely and translate process errors into toolbelt outcomes."""
    label = "[redacted command]" if sensitive else "command: " + " ".join(argv)
    if not quiet:
        note(label)
    popen_options: dict[str, object] = {"cwd": str(cwd) if cwd else None, "shell": False}
    if sensitive or quiet:
        popen_options.update({"stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "text": True})
    if os.name == "nt":
        popen_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_options["start_new_session"] = True
    try:
        process = subprocess.Popen(list(argv), **popen_options)
        job = _create_windows_job(process) if os.name == "nt" else None
        process.communicate(timeout=timeout)
    except FileNotFoundError:
        if not quiet:
            note(f"unavailable: {argv[0]}")
        return MISSING
    except subprocess.TimeoutExpired:
        _terminate_process_tree(process, job)
        job = None
        if not quiet:
            note(f"timed out after {timeout}s")
        return FAILED
    except KeyboardInterrupt:
        if "process" in locals():
            _terminate_process_tree(process, locals().get("job"))
            job = None
        raise
    except OSError as error:
        if not quiet:
            note(f"unable to execute {argv[0]}: {error}")
        return FAILED
    finally:
        _close_windows_job(locals().get("job"))
    if process.returncode == 0:
        if sensitive and not quiet:
            note("sensitive command completed")
        return OK
    if sensitive and not quiet:
        note(f"sensitive command failed with exit status {process.returncode}; output suppressed")
    return FAILED


def _terminate_process_tree(process: subprocess.Popen[object], job: object | None = None) -> None:
    """Terminate a timed-out child and descendants without a shell or PID guessing."""
    try:
        if os.name == "nt":
            taskkill = subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      timeout=15, check=False, shell=False)
            if taskkill.returncode != 0:
                process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        process.kill()
    finally:
        # This timeout path owns the job. Closing it kills all assigned descendants,
        # including when taskkill is denied by a restricted Windows host.
        _close_windows_job(job)
        try:
            process.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()


def _create_windows_job(process: subprocess.Popen[object]) -> object | None:
    """Use a kill-on-close job as a restricted-environment fallback for taskkill."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class BasicLimit(ctypes.Structure):
            _fields_ = [("per_process", ctypes.c_longlong), ("per_job", ctypes.c_longlong),
                        ("flags", wintypes.DWORD), ("minimum", ctypes.c_size_t),
                        ("maximum", ctypes.c_size_t), ("active", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                        ("scheduling", wintypes.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]

        class ExtendedLimit(ctypes.Structure):
            _fields_ = [("basic", BasicLimit), ("io", IoCounters),
                        ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                        ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                      wintypes.LPVOID, wintypes.DWORD]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        limit = ExtendedLimit()
        limit.basic.flags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(limit), ctypes.sizeof(limit)):
            kernel32.CloseHandle(job)
            return None
        if not kernel32.AssignProcessToJobObject(job, process._handle):  # type: ignore[attr-defined]
            kernel32.CloseHandle(job)
            return None
        return job
    except (AttributeError, OSError):
        return None


def _close_windows_job(job: object | None) -> None:
    if job is None or os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.CloseHandle(job)
    except (AttributeError, OSError):
        pass


def project_path(value: str | None) -> Path | None:
    path = Path(value or ".").expanduser().resolve()
    if not path.is_dir():
        note(f"project directory not found: {path}")
        return None
    return path


def file_path(value: str | None, usage: str) -> Path | None:
    if not value:
        note(f"usage: {usage}")
        return None
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        note(f"file not found: {path}")
        return None
    return path


def project_python(project: Path) -> str:
    # A checkout may contain artifacts from another OS; never execute its venv.
    candidates = [project / ".venv" / "Scripts" / "python.exe"] if os.name == "nt" else [
        project / ".venv" / "bin" / "python", project / ".venv" / "bin" / "python3"]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return sys.executable


def python_module_available(python: str, module: str) -> bool:
    return run([python, "-c", f"import {module}"], timeout=20, quiet=True) == OK


def read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConfigurationError(f"invalid {path.name}: {error}") from error
    if not isinstance(data, dict):
        raise ConfigurationError(f"invalid {path.name}: root must be an object")
    return data


def load_pyproject(project: Path) -> dict | None:
    path = project / "pyproject.toml"
    if not path.is_file() or tomllib is None:
        return None
    try:
        value = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise ConfigurationError(f"invalid pyproject.toml: {error}") from error
    if not isinstance(value, dict):
        raise ConfigurationError("invalid pyproject.toml: root must be an object")
    return value


def pyproject_tools(project: Path) -> set[str]:
    value = load_pyproject(project)
    tool = value.get("tool", {}) if value else {}
    if not isinstance(tool, dict):
        raise ConfigurationError("invalid pyproject.toml: tool must be an object")
    return set(tool) if isinstance(tool, dict) else set()


def configured_command(project: Path, name: str) -> list[str] | None:
    """Read one explicit argv command from [tool.codex_toolbelt]."""
    config = load_pyproject(project)
    if config is None:
        return None
    tool = config.get("tool", {})
    if not isinstance(tool, dict):
        raise ConfigurationError("invalid pyproject.toml: tool must be an object")
    section = tool.get("codex_toolbelt")
    if section is None:
        return None
    if not isinstance(section, dict):
        raise ConfigurationError("invalid [tool.codex_toolbelt] section")
    value = section.get(name)
    if value is None:
        return None
    if not isinstance(value, list) or not value or not all(isinstance(part, str) for part in value):
        raise ConfigurationError(f"invalid [tool.codex_toolbelt].{name}: expected a non-empty argv array")
    python = project_python(project)
    return [part.replace("{python}", python).replace("{project}", str(project)) for part in value]


def package_manager(project: Path, package: dict) -> tuple[list[str] | None, str | None]:
    """Return a fixed manager argv prefix, never falling back across managers."""
    declared = package.get("packageManager")
    declared_name = declared.split("@", 1)[0] if isinstance(declared, str) else None
    lockfiles = {"pnpm": "pnpm-lock.yaml", "yarn": "yarn.lock", "npm": "package-lock.json"}
    found = [name for name, filename in lockfiles.items() if (project / filename).is_file()]
    if declared_name and declared_name not in lockfiles:
        return None, f"unsupported packageManager: {declared_name}"
    if declared_name and found and any(name != declared_name for name in found):
        return None, "packageManager conflicts with lockfile"
    if not declared_name:
        if len(found) != 1:
            return None, "declare packageManager or provide exactly one supported lockfile"
        declared_name = found[0]
    command = executable(declared_name)
    if not command:
        return None, f"{declared_name}: unavailable"
    command_path = Path(command)
    if sys.platform == "win32" and command_path.suffix.lower() in {".cmd", ".bat"}:
        node = executable("node")
        cli_names = (f"{declared_name}-cli.js", "cli.js", "pnpm.cjs", "pnpm.mjs", "yarn.js")
        candidates = [
            command_path.parent / "node_modules" / declared_name / "bin" / cli_name
            for cli_name in cli_names
        ]
        if node:
            candidates.extend(Path(node).resolve().parent / "node_modules" / declared_name / "bin" / cli_name for cli_name in cli_names)
            candidates.extend(Path(node).resolve().parent.parent / "node_modules" / declared_name / "bin" / cli_name for cli_name in cli_names)
        cli = next((candidate for candidate in candidates if candidate.is_file()), None)
        if cli and node:
            return [node, str(cli)], None
        return None, f"{declared_name} command wrapper cannot be invoked safely and its Node CLI is unavailable"
    return [command], None


def package_context(project: Path) -> tuple[dict, list[str]] | None:
    package = read_json(project / "package.json")
    if package is None:
        return None
    manager, error = package_manager(project, package)
    if error or manager is None:
        note(error or "package manager unavailable")
        return None
    return package, manager


def package_script(project: Path, package: dict, manager: list[str], name: str) -> int:
    scripts = package.get("scripts")
    if not isinstance(scripts, dict) or not isinstance(scripts.get(name), str):
        note(f"package script not declared: {name}")
        return MISSING
    return run([*manager, "run", name], cwd=project)


def cmd_repo_health(args: list[str]) -> int:
    project = project_path(args[0] if args else None)
    if not project:
        return MISSING
    git = executable("git")
    if not git:
        note("git: unavailable")
        return MISSING
    inside = run([git, "rev-parse", "--is-inside-work-tree"], cwd=project, timeout=30, quiet=True) == OK
    if not inside:
        note("git: project is not a repository")
        return MISSING
    outcomes = [run([git, "status", "--short", "--branch"], cwd=project),
                run([git, "diff", "--check"], cwd=project)]
    markers = [name for name in ("pyproject.toml", "package.json", "Cargo.toml", "go.mod", "Dockerfile", "compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml") if (project / name).exists()]
    note("project markers: " + (", ".join(markers) if markers else "none"))
    return result_code(outcomes)


def cmd_test(args: list[str]) -> int:
    project = project_path(args[0] if args else None)
    if not project:
        return MISSING
    outcomes: list[int] = []
    configured = configured_command(project, "test")
    if configured:
        outcomes.append(run(configured, cwd=project))
    elif (project / "pytest.ini").is_file() or (project / "tests").is_dir() or (project / "pyproject.toml").is_file() and "pytest" in pyproject_tools(project):
        python = project_python(project)
        if python_module_available(python, "pytest"):
            outcomes.append(run([python, "-m", "pytest", "-q"], cwd=project))
        else:
            note("pytest: unavailable in selected Python environment")
            outcomes.append(MISSING)
    if (project / "package.json").is_file():
        context = package_context(project)
        if context is None:
            outcomes.append(MISSING)
        else:
            outcomes.append(package_script(project, *context, "test"))
    if (project / "Cargo.toml").is_file():
        cargo = executable("cargo")
        outcomes.append(run([cargo, "test"], cwd=project) if cargo else MISSING)
    if (project / "go.mod").is_file():
        go = executable("go")
        outcomes.append(run([go, "test", "./..."], cwd=project) if go else MISSING)
    if not outcomes:
        note("no configured test runner found")
    return result_code(outcomes)


def cmd_lint(args: list[str]) -> int:
    project = project_path(args[0] if args else None)
    if not project:
        return MISSING
    outcomes: list[int] = []
    tools = pyproject_tools(project)
    python = project_python(project)
    for name in ("ruff", "mypy"):
        if name in tools:
            if python_module_available(python, name):
                command = [python, "-m", name, "check", "."] if name == "ruff" else [python, "-m", name, "."]
                outcomes.append(run(command, cwd=project))
            else:
                note(f"{name}: unavailable in selected Python environment")
                outcomes.append(MISSING)
    if (project / "package.json").is_file():
        context = package_context(project)
        if context is None:
            outcomes.append(MISSING)
        else:
            outcomes.extend(package_script(project, *context, name) for name in ("lint", "typecheck", "type-check") if isinstance(context[0].get("scripts"), dict) and name in context[0]["scripts"])
    if (project / "go.mod").is_file():
        go = executable("go")
        outcomes.append(run([go, "vet", "./..."], cwd=project) if go else MISSING)
    if (project / "Cargo.toml").is_file():
        cargo = executable("cargo")
        outcomes.append(run([cargo, "clippy", "--all-targets", "--all-features", "--", "-D", "warnings"], cwd=project) if cargo else MISSING)
    if not outcomes:
        note("no configured linter or type checker found")
    return result_code(outcomes)


def cmd_security(args: list[str]) -> int:
    project = project_path(args[0] if args else None)
    if not project:
        return MISSING
    configured = configured_command(project, "security")
    if configured:
        return run(configured, cwd=project)
    if not (project / "package.json").is_file():
        note("no configured security check found")
        return MISSING
    context = package_context(project)
    if context is None:
        return MISSING
    return package_script(project, *context, "security")


def cmd_docker_check(args: list[str]) -> int:
    project = project_path(args[0] if args else None)
    if not project:
        return MISSING
    compose = next((name for name in ("compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml") if (project / name).is_file()), None)
    dockerfile = project / "Dockerfile"
    nginx = project / "nginx.conf"
    if not compose and not dockerfile.is_file() and not nginx.is_file():
        note("no Docker, Compose, or Nginx configuration found")
        return MISSING
    outcomes: list[int] = []
    if compose or dockerfile.is_file():
        docker = executable("docker")
        if not docker:
            note("docker: unavailable")
            outcomes.append(MISSING)
        else:
            if compose:
                outcomes.append(run([docker, "compose", "config", "--quiet"], cwd=project))
            if dockerfile.is_file():
                outcomes.append(run([docker, "buildx", "build", "--check", "."], cwd=project))
    if nginx.is_file():
        nginx_bin = executable("nginx")
        outcomes.append(run([nginx_bin, "-t", "-c", str(nginx)], cwd=project) if nginx_bin else MISSING)
    return result_code(outcomes)


def cmd_db_check(args: list[str]) -> int:
    if args and not project_path(args[0]):
        return MISSING
    outcomes: list[int] = []
    database_url, redis_url = os.environ.get("DATABASE_URL"), os.environ.get("REDIS_URL")
    if database_url:
        psql = executable("psql")
        if not psql:
            note("psql: unavailable for configured DATABASE_URL")
            outcomes.append(MISSING)
        else:
            outcomes.append(run([psql, database_url, "-X", "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1;"], sensitive=True, timeout=30))
    if redis_url:
        redis = executable("redis-cli")
        if not redis:
            note("redis-cli: unavailable for configured REDIS_URL")
            outcomes.append(MISSING)
        else:
            outcomes.append(run([redis, "-u", redis_url, "--no-auth-warning", "PING"], sensitive=True, timeout=30))
    if not outcomes:
        note("DATABASE_URL or REDIS_URL is required for an explicit read-only probe")
    return result_code(outcomes)


def inferred_type(value: str | None) -> str:
    if value is None or value == "":
        return "null"
    if value.lower() in {"true", "false"}:
        return "boolean"
    try:
        int(value)
        return "integer"
    except ValueError:
        try:
            float(value)
            return "number"
        except ValueError:
            return "string"


def profile_rows(rows: list[dict[str, object]], declared_columns: Sequence[str] = ()) -> dict[str, object]:
    columns = list(dict.fromkeys([*declared_columns, *sorted({key for row in rows for key in row})]))
    missing = {key: sum(1 for row in rows if row.get(key) in (None, "")) for key in columns}
    types = {key: sorted({inferred_type(None if row.get(key) is None else str(row.get(key))) for row in rows}) for key in columns}
    return {"sampled_rows": len(rows), "columns": columns, "missing": missing, "types": types,
            "values_included": False}


def cmd_dataset_inspect(args: list[str]) -> int:
    path = file_path(args[0] if args else None, "dataset-inspect <csv|tsv|json|jsonl|parquet>")
    if not path:
        return MISSING
    if path.stat().st_size > MAX_DATASET_BYTES:
        note(f"dataset exceeds {MAX_DATASET_BYTES} byte inspection limit")
        return MISSING
    suffix = path.suffix.lower()
    try:
        if suffix in {".csv", ".tsv"}:
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                reader = csv.reader(handle, delimiter="\t" if suffix == ".tsv" else ",", strict=True)
                headers = next(reader, None)
                if not headers:
                    raise ValueError("CSV has no header row")
                if len(headers) != len(set(headers)):
                    raise ValueError("CSV header names must be unique")
                rows = []
                for row_number, values in enumerate(reader, start=2):
                    if len(values) != len(headers):
                        raise ValueError(f"CSV row {row_number} has {len(values)} fields; expected {len(headers)}")
                    rows.append(dict(zip(headers, values)))
                    if len(rows) >= MAX_DATASET_ROWS:
                        break
        elif suffix in {".jsonl", ".ndjson"}:
            with path.open("r", encoding="utf-8") as handle:
                values = [json.loads(line) for _, line in zip(range(MAX_DATASET_ROWS), handle) if line.strip()]
            rows = [value if isinstance(value, dict) else {"value": value} for value in values]
        elif suffix == ".json":
            value = json.loads(path.read_text(encoding="utf-8"))
            values = value if isinstance(value, list) else [value]
            rows = [(item if isinstance(item, dict) else {"value": item}) for item in values[:MAX_DATASET_ROWS]]
        elif suffix in {".parquet", ".pq"}:
            if importlib.util.find_spec("pyarrow") is None:
                note("pyarrow is required to inspect Parquet")
                return MISSING
            import pyarrow.parquet as parquet  # type: ignore[import-not-found]
            reader = parquet.ParquetFile(path)
            try:
                batch = next(reader.iter_batches(batch_size=MAX_DATASET_ROWS), None)
                rows = batch.to_pylist() if batch is not None else []
            finally:
                reader.close()
        else:
            note(f"unsupported dataset extension: {suffix}")
            return MISSING
    except (OSError, UnicodeDecodeError, csv.Error, json.JSONDecodeError, ValueError) as error:
        note(f"dataset parse failed: {error}")
        return FAILED
    print(json.dumps({"path": str(path), "size_bytes": path.stat().st_size,
                      **profile_rows(rows, headers if suffix in {".csv", ".tsv"} else ())}, indent=2, sort_keys=True))
    return OK


def cmd_gpu_check(args: list[str]) -> int:
    project = project_path(args[0] if args else None)
    if not project:
        return MISSING
    outcomes: list[int] = []
    nvidia = executable("nvidia-smi")
    if nvidia:
        outcomes.append(run([nvidia, "--query-gpu=name,memory.total,memory.used,driver_version", "--format=csv,noheader"], timeout=30))
    python = project_python(project)
    if python_module_available(python, "torch"):
        outcomes.append(run([python, "-c", "import torch; print('torch=' + torch.__version__); print('cuda_available=' + str(torch.cuda.is_available()))"], timeout=30))
    else:
        note("torch: unavailable")
        outcomes.append(MISSING)
    return result_code(outcomes)


def cmd_api_check(args: list[str]) -> int:
    if not args:
        note("usage: api-check <http:// or https:// URL>")
        return MISSING
    try:
        parsed = urllib.parse.urlparse(args[0])
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("URL must include http or https scheme and host")
        request = urllib.request.Request(args[0], method="GET", headers={"User-Agent": "codex-toolbelt/1"})
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            note(f"status: {response.status}")
            for header in ("Content-Type", "Content-Length"):
                if value := response.headers.get(header):
                    note(f"{header.lower()}: {value}")
        return OK
    except (ValueError, urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
        note(f"HTTP probe failed: {error}")
        return FAILED


def cmd_frontend_check(args: list[str]) -> int:
    project = project_path(args[0] if args else None)
    if not project or not (project / "package.json").is_file():
        note("package.json not found")
        return MISSING
    context = package_context(project)
    if context is None:
        return MISSING
    package, manager = context
    scripts = package.get("scripts") if isinstance(package.get("scripts"), dict) else {}
    outcomes = [package_script(project, package, manager, name) for name in ("lint", "typecheck", "type-check", "test", "test:e2e") if name in scripts]
    if not outcomes:
        note("no frontend check scripts declared")
    return result_code(outcomes)


def cmd_ml_check(args: list[str]) -> int:
    project = project_path(args[0] if args else None)
    if not project:
        return MISSING
    python = project_python(project)
    modules = ("numpy", "pandas", "sklearn", "torch", "transformers", "xgboost", "lightgbm", "catboost", "joblib")
    probe = "import importlib.util, platform, sys; print('python=' + sys.executable); print('version=' + platform.python_version()); print('modules=' + ','.join(name for name in sys.argv[1:] if importlib.util.find_spec(name)))"
    options: dict[str, object] = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE,
                                  "text": True, "shell": False}
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    try:
        process = subprocess.Popen([python, "-c", probe, *modules], **options)
        job = _create_windows_job(process) if os.name == "nt" else None
        stdout, _ = process.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        _terminate_process_tree(process, job)
        job = None
        note("ML environment probe timed out")
        return FAILED
    except KeyboardInterrupt:
        if "process" in locals():
            _terminate_process_tree(process, locals().get("job"))
            job = None
        raise
    except OSError as error:
        note(f"ML environment probe failed: {error}")
        return MISSING
    finally:
        _close_windows_job(locals().get("job"))
    if process.returncode != 0:
        note("ML environment probe failed")
        return FAILED
    found_line = next((line for line in stdout.splitlines() if line.startswith("modules=")), "modules=")
    found = [name for name in found_line.removeprefix("modules=").split(",") if name]
    note(f"python: {python}")
    note(f"platform: {platform.platform()}")
    note("ML modules: " + (", ".join(found) if found else "none"))
    return OK if found else MISSING


def cmd_benchmark(args: list[str]) -> int:
    if not args:
        note("usage: benchmark <command> [args...]")
        return MISSING
    start = time.perf_counter()
    code = run(args, timeout=TIMEOUT_SECONDS)
    note(f"elapsed_seconds: {time.perf_counter() - start:.6f}")
    return code


def cmd_openapi_check(args: list[str]) -> int:
    path = file_path(args[0] if args else None, "openapi-check <openapi.json|openapi.yaml>")
    if not path:
        return MISSING
    try:
        if path.suffix.lower() == ".json":
            spec = json.loads(path.read_text(encoding="utf-8"))
        elif path.suffix.lower() in {".yaml", ".yml"}:
            if importlib.util.find_spec("yaml") is None:
                note("PyYAML is required to parse OpenAPI YAML")
                return MISSING
            import yaml  # type: ignore[import-not-found]
            spec = yaml.safe_load(path.read_text(encoding="utf-8"))
        else:
            note("OpenAPI input must be JSON or YAML")
            return MISSING
        if not isinstance(spec, dict) or not isinstance(spec.get("paths"), dict):
            raise ValueError("spec root and paths must be objects")
        version = spec.get("openapi", spec.get("swagger"))
        if not isinstance(version, str):
            raise ValueError("missing openapi/swagger version")
        note(json.dumps({"version": version, "path_count": len(spec["paths"]),
                          "title": spec.get("info", {}).get("title") if isinstance(spec.get("info"), dict) else None}, sort_keys=True))
    except Exception as error:
        note(f"OpenAPI structural validation failed: {error}")
        return FAILED
    if importlib.util.find_spec("openapi_spec_validator") is None:
        note("structural validation passed; full openapi-spec-validator is unavailable")
        return MISSING
    try:
        from openapi_spec_validator import validate_spec  # type: ignore[import-not-found]
        validate_spec(spec)
    except Exception as error:
        note(f"OpenAPI full validation failed: {error}")
        return FAILED
    note("full OpenAPI validation passed")
    return OK


def cmd_doctor(args: list[str]) -> int:
    """Load the sibling module by path so spec-loaded tests also work."""
    path = Path(__file__).with_name("doctor.py")
    if not path.is_file():
        note("doctor.py: unavailable")
        return MISSING
    spec = importlib.util.spec_from_file_location("_codex_toolbelt_doctor", path)
    if spec is None or spec.loader is None:
        note("doctor.py: cannot be loaded")
        return FAILED
    module = importlib.util.module_from_spec(spec)
    try:
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        entry = getattr(module, "main")
        return int(entry(args))
    except (OSError, AttributeError, TypeError, ValueError) as error:
        note(f"doctor failed: {error}")
        return FAILED
    finally:
        sys.modules.pop(spec.name, None)


COMMANDS: dict[str, Callable[[list[str]], int]] = {
    "repo-health": cmd_repo_health, "test": cmd_test, "lint": cmd_lint,
    "security": cmd_security, "docker-check": cmd_docker_check,
    "db-check": cmd_db_check, "dataset-inspect": cmd_dataset_inspect,
    "gpu-check": cmd_gpu_check, "api-check": cmd_api_check,
    "frontend-check": cmd_frontend_check, "ml-check": cmd_ml_check,
    "benchmark": cmd_benchmark, "openapi-check": cmd_openapi_check,
    "doctor": cmd_doctor,
}
ONE_ARGUMENT_COMMANDS = frozenset(COMMANDS) - {"benchmark", "doctor"}


def final_result(code: int) -> int:
    label = {OK: "PASS", FAILED: "FAIL", MISSING: "MISSING"}.get(code, "FAIL")
    note(f"RESULT {label}")
    return code if code in {OK, FAILED, MISSING} else FAILED


def main(argv: list[str] | None = None) -> int:
    values = list(sys.argv[1:] if argv is None else argv)
    if sys.version_info < (3, 11):
        note("toolbelt requires Python 3.11 or newer")
        return final_result(MISSING)
    if not values or values[0] in {"-h", "--help"}:
        note("usage: toolbelt.py <" + "|".join(COMMANDS) + "> [arguments]")
        return final_result(OK)
    command = values.pop(0)
    handler = COMMANDS.get(command)
    if handler is None:
        note(f"unknown command: {command}")
        return final_result(MISSING)
    if command in ONE_ARGUMENT_COMMANDS and len(values) > 1:
        note(f"usage: {command} accepts at most one argument")
        return final_result(MISSING)
    try:
        return final_result(handler(values))
    except ConfigurationError as error:
        note(f"configuration failed: {error}")
        return final_result(FAILED)
    except KeyboardInterrupt:
        note("interrupted")
        return final_result(FAILED)
    except Exception as error:
        note(f"check failed: {error}")
        return final_result(FAILED)


if __name__ == "__main__":
    raise SystemExit(main())
