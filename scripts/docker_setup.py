"""Prepare private local Docker settings without overwriting existing secrets."""

import argparse
import os
import secrets
import stat
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SECRET_NAMES = ("postgres_password", "app_password", "demo_password")
OPTIONAL_SECRET_NAMES = ("ai_api_key", "vapid_private.pem")
DEMO_PASSWORD = "TechNaryad2026!"
SECRET_DIRECTORY_MODE = 0o700
SECRET_FILE_MODE = 0o444


class SecretPathError(RuntimeError):
    """A Compose secret path cannot safely be used as a file."""


def _secret_directory_problem(path: Path) -> str | None:
    """Describe an existing secrets directory that cannot safely be used."""
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return None

    if stat.S_ISLNK(mode):
        return "symbolic link"
    if not stat.S_ISDIR(mode):
        return "not a directory"
    return None


def _secret_path_problem(path: Path) -> str | None:
    """Describe an unusable secret path without reading its value."""
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return None

    if stat.S_ISLNK(mode):
        return "symbolic link"
    if stat.S_ISDIR(mode):
        try:
            return "empty directory" if not any(path.iterdir()) else "non-empty directory"
        except OSError as error:
            return f"unreadable directory ({error.strerror or error})"
    if not stat.S_ISREG(mode):
        return "not a regular file"
    if path.stat().st_size == 0:
        return "empty file"
    try:
        contents = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return "unreadable UTF-8 text file"
    if not contents.strip():
        return "blank file"
    if "\0" in contents:
        return "binary file"
    return None


def _settings_path_problem(path: Path) -> str | None:
    """Describe an existing Docker settings path that cannot safely be preserved."""
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return None

    if stat.S_ISLNK(mode):
        return "symbolic link"
    if stat.S_ISDIR(mode):
        return "directory"
    if not stat.S_ISREG(mode):
        return "not a regular file"
    return None


def _write_secret(path: Path, name: str) -> None:
    value = DEMO_PASSWORD if name == "demo_password" else secrets.token_urlsafe(32)
    _write_private_file(path, value + "\n")


def _write_private_file(path: Path, contents: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(contents)


def _mode_change_problem(path: Path, target_mode: int) -> str | None:
    """Reject permission changes for files not owned by the current POSIX user."""
    current = path.lstat()
    if stat.S_ISLNK(current.st_mode):
        return "symbolic link"
    if current.st_mode & 0o777 == target_mode:
        return None
    getuid = getattr(os, "getuid", None)
    if getuid is not None and current.st_uid != getuid():
        return "is not owned by the current user"
    return None


def prepare(root: Path = ROOT, *, repair_empty_secret_dirs: bool = False) -> None:
    directory = root / "var/docker/secrets"
    directory_problem = _secret_directory_problem(directory)
    if directory_problem is not None:
        raise SecretPathError(
            "Docker secrets directory must be a real directory, "
            f"not {directory_problem}: {directory}."
        )
    directory.mkdir(parents=True, exist_ok=True, mode=SECRET_DIRECTORY_MODE)

    paths = {name: directory / name for name in SECRET_NAMES + OPTIONAL_SECRET_NAMES}
    problems = []
    empty_directories = []
    for name, path in paths.items():
        problem = _secret_path_problem(path)
        if problem is None:
            continue
        if problem == "empty directory" and repair_empty_secret_dirs and name in SECRET_NAMES:
            empty_directories.append(path)
        else:
            problems.append((path, problem))

    settings = root / ".env.docker"
    settings_problem = _settings_path_problem(settings)
    if settings_problem is not None:
        problems.append((settings, settings_problem))

    mode_paths = [directory]
    mode_paths.extend(path for path in paths.values() if path.exists())
    for path in mode_paths:
        target_mode = SECRET_DIRECTORY_MODE if path == directory else SECRET_FILE_MODE
        mode_problem = _mode_change_problem(path, target_mode)
        if mode_problem is not None:
            problems.append((path, mode_problem))

    if problems:
        details = "; ".join(f"{path}: {problem}" for path, problem in problems)
        raise SecretPathError(
            "Docker secret paths must be non-empty regular UTF-8 text files. "
            f"Fix these paths and rerun: {details}. "
            "For an empty secret directory on a brand-new setup only, rerun with "
            "--repair-empty-secret-dirs."
        )

    for path in empty_directories:
        try:
            path.rmdir()
        except OSError as error:
            raise SecretPathError(
                f"Could not remove empty secret directory {path}: {error.strerror or error}"
            ) from error

    for name in SECRET_NAMES:
        path = paths[name]
        if not path.exists():
            _write_secret(path, name)
    directory.chmod(SECRET_DIRECTORY_MODE)
    for path in paths.values():
        if path.exists():
            path.chmod(SECRET_FILE_MODE)
    if not settings.exists():
        _write_private_file(
            settings,
            "NARYADAI_BIND=127.0.0.1\n"
            "NARYADAI_HTTP_PORT=8080\n"
            "NARYADAI_HTTPS_PORT=8443\n"
            "NARYADAI_SITE_ADDRESS=http://:80\n"
            'NARYADAI_ALLOWED_HOSTS=["localhost","127.0.0.1"]\n'
            "NARYADAI_CORS_ORIGINS=[]\n",
        )
    print("Private Docker settings ready. Existing configuration and secrets preserved.")
    print("Start: docker compose --env-file .env.docker up -d --build")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repair-empty-secret-dirs",
        action="store_true",
        help=(
            "replace empty directories at Docker secret paths for a brand-new setup; "
            "do not use after PostgreSQL initialization"
        ),
    )
    arguments = parser.parse_args()
    try:
        prepare(repair_empty_secret_dirs=arguments.repair_empty_secret_dirs)
    except SecretPathError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
